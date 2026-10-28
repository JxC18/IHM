"""Accès BigQuery. Seul module à détenir un client (le front n'a jamais de credentials, PRD §8.1).

Trois usages : tester les requêtes (F3), lire les indicateurs (F6, F7) et publier les
règles dans `rules_registry` pour l'équipe data et Airflow (PRD §7.2).

Les garde-fous F3 sont posés ici, côté serveur, donc non contournables depuis l'IHM :
`maximum_bytes_billed`, `job_timeout_ms`, `max_results`.
"""

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from functools import lru_cache
from typing import Any, Protocol

from app.core import Settings, get_settings
from app.database import Rule, RuleVersion
from app.schemas import Column, DailyPerformance, RuleRun, VersionPerformance

log = logging.getLogger(__name__)


class QueryError(Exception):
    """Erreur BigQuery, avec la position (ligne, colonne) quand le message la donne."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
        m = re.search(r"at \[(\d+):(\d+)\]", message)
        self.line = int(m.group(1)) if m else None
        self.column = int(m.group(2)) if m else None


class BytesLimitExceeded(Exception):
    pass


@dataclass
class DryRunMeta:
    statement_type: str
    bytes_processed: int
    schema: list[Column]


@dataclass
class ExecMeta:
    columns: list[str]
    rows: list[dict[str, Any]]
    total_rows: int
    duration_ms: int
    bytes_processed: int


@dataclass
class RunStats:
    """Synthèse des exécutions Airflow d'une version de règle (table `rule_runs`)."""

    rule_id: str
    rule_version: int
    first_run_at: datetime
    last_run_at: datetime
    dag_id: str | None


@dataclass
class ProductionTotals:
    rule_id: str
    flagged: int
    processed: int
    confirmed: int


class BigQueryGateway(Protocol):
    def dry_run(self, sql: str, run_date: date) -> DryRunMeta: ...

    def execute(self, sql: str, run_date: date) -> ExecMeta: ...

    def daily_performance(self, rule_id: str, start: date, end: date) -> list[DailyPerformance]: ...

    def runs(self, rule_id: str, start: date, end: date, limit: int = 20) -> list[RuleRun]: ...

    def version_totals(self, rule_id: str) -> list[VersionPerformance]: ...

    def production_totals(self, rule_ids: list[str], start: date, end: date) -> list[ProductionTotals]: ...

    def run_stats(self) -> list[RunStats]: ...

    def upsert_rule(self, rule: Rule, v: RuleVersion, status: str) -> None:
        """Écrit dans `rules_registry` la version à exécuter de la règle : une ligne par règle,
        insérée à la première soumission puis mise à jour (UPDATE) à chaque nouvelle version."""
        ...

    def delete_rule(self, rule_id: str) -> None:
        """Retire la règle de `rules_registry` (sa seule version soumise a été reprise en brouillon)."""
        ...


# ---------------------------------------------------------------------------
# Implémentation réelle
# ---------------------------------------------------------------------------


class RealBigQueryGateway:
    def __init__(self, settings: Settings):
        from google.cloud import bigquery

        self._bq = bigquery
        self.settings = settings
        self.client = bigquery.Client(project=settings.gcp_project or None, location=settings.bq_location)
        self.ds = f"`{self.client.project}.{settings.bq_dataset}`"

    def _config(self, run_date: date, **kw):
        # @run_date est le seul paramètre de requête (les seuils sont écrits dans le SQL).
        qp = [self._bq.ScalarQueryParameter("run_date", "DATE", run_date)]
        return self._bq.QueryJobConfig(
            query_parameters=qp, use_query_cache=False, labels={"app": "rules-manager"}, **kw
        )

    def dry_run(self, sql, run_date):
        from google.api_core.exceptions import GoogleAPICallError

        try:
            job = self.client.query(sql, job_config=self._config(run_date, dry_run=True))
        except GoogleAPICallError as e:
            raise QueryError(getattr(e, "message", str(e))) from e
        schema = [Column(name=f.name, type=f.field_type) for f in (job.schema or [])]
        return DryRunMeta(job.statement_type or "UNKNOWN", job.total_bytes_processed or 0, schema)

    def execute(self, sql, run_date):
        from google.api_core.exceptions import GoogleAPICallError

        cfg = self._config(run_date, maximum_bytes_billed=self.settings.max_bytes_billed)
        cfg.job_timeout_ms = self.settings.job_timeout_ms
        start = time.monotonic()
        try:
            job = self.client.query(sql, job_config=cfg)
            it = job.result(
                max_results=self.settings.max_results, timeout=self.settings.job_timeout_ms / 1000
            )
            rows = [{k: _jsonable(v) for k, v in r.items()} for r in it]
        except GoogleAPICallError as e:
            msg = getattr(e, "message", str(e))
            if "bytesBilledLimitExceeded" in str(e) or "bytes billed" in msg.lower():
                raise BytesLimitExceeded(msg) from e
            raise QueryError(msg) from e
        return ExecMeta(
            columns=[f.name for f in it.schema],
            rows=rows,
            total_rows=it.total_rows or 0,
            duration_ms=int((time.monotonic() - start) * 1000),
            bytes_processed=job.total_bytes_processed or 0,
        )

    def _rows(self, sql: str, params: list) -> list[dict]:
        cfg = self._bq.QueryJobConfig(query_parameters=params)
        return [dict(r.items()) for r in self.client.query(sql, job_config=cfg).result()]

    def daily_performance(self, rule_id, start, end):
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            f"""SELECT run_date, rule_version, orders_flagged, orders_processed, orders_confirmed_fraud
                FROM {self.ds}.v_rule_performance
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end
                ORDER BY run_date""",
            [P("rule_id", "STRING", rule_id), P("start", "DATE", start), P("end", "DATE", end)],
        )
        return [
            DailyPerformance(
                date=r["run_date"],
                rule_version=r["rule_version"],
                orders_flagged=r["orders_flagged"],
                orders_processed=r["orders_processed"],
                orders_confirmed_fraud=r["orders_confirmed_fraud"],
            )
            for r in rows
        ]

    def version_totals(self, rule_id):
        rows = self._rows(
            f"""SELECT rule_version AS version, MIN(run_date) AS first_date, MAX(run_date) AS last_date,
                       COUNT(*) AS days, SUM(orders_flagged) AS orders_flagged,
                       SUM(orders_processed) AS orders_processed,
                       SUM(orders_confirmed_fraud) AS orders_confirmed_fraud
                FROM {self.ds}.v_rule_performance
                WHERE rule_id = @rule_id
                GROUP BY rule_version
                ORDER BY rule_version""",
            [self._bq.ScalarQueryParameter("rule_id", "STRING", rule_id)],
        )
        return [VersionPerformance.model_validate(r) for r in rows]

    def runs(self, rule_id, start, end, limit=20):
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            f"""SELECT * FROM {self.ds}.rule_runs
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end
                ORDER BY started_at DESC LIMIT @limit""",
            [
                P("rule_id", "STRING", rule_id),
                P("start", "DATE", start),
                P("end", "DATE", end),
                P("limit", "INT64", limit),
            ],
        )
        return [RuleRun.model_validate(r) for r in rows]

    def production_totals(self, rule_ids, start, end):
        if not rule_ids:
            return []
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            f"""SELECT rule_id, SUM(orders_flagged) AS flagged, SUM(orders_processed) AS processed,
                       SUM(orders_confirmed_fraud) AS confirmed
                FROM {self.ds}.v_rule_performance
                WHERE rule_id IN UNNEST(@ids) AND run_date BETWEEN @start AND @end
                GROUP BY rule_id""",
            [
                self._bq.ArrayQueryParameter("ids", "STRING", rule_ids),
                P("start", "DATE", start),
                P("end", "DATE", end),
            ],
        )
        return [
            ProductionTotals(r["rule_id"], r["flagged"] or 0, r["processed"] or 0, r["confirmed"] or 0)
            for r in rows
        ]

    def run_stats(self):
        rows = self._rows(
            f"""SELECT rule_id, rule_version, MIN(started_at) AS first_run_at, MAX(started_at) AS last_run_at,
                       ARRAY_AGG(airflow_dag_id ORDER BY started_at DESC LIMIT 1)[OFFSET(0)] AS dag_id
                FROM {self.ds}.rule_runs
                GROUP BY rule_id, rule_version""",
            [],
        )
        return [RunStats(**r) for r in rows]

    def delete_rule(self, rule_id: str) -> None:
        cfg = self._bq.QueryJobConfig(
            query_parameters=[self._bq.ScalarQueryParameter("rule_id", "STRING", rule_id)]
        )
        sql = f"DELETE FROM {self.ds}.rules_registry WHERE rule_id = @rule_id"
        self.client.query(sql, job_config=cfg).result()

    def upsert_rule(self, rule: Rule, v: RuleVersion, status: str) -> None:
        P = self._bq.ScalarQueryParameter
        params = [
            P("rule_id", "STRING", v.rule_id),
            P("version", "INT64", v.version),
            P("name", "STRING", v.name),
            P("description", "STRING", v.description),
            P("fraud_typology", "STRING", v.fraud_typology),
            P("criticality", "STRING", v.criticality),
            P("schedule", "STRING", v.schedule),
            P("sql_query", "STRING", v.sql_query),
            P("status", "STRING", status),
            P("owner_matricule", "STRING", rule.owner_matricule),
            P("created_at", "TIMESTAMP", rule.created_at),
            P("updated_at", "TIMESTAMP", v.updated_at),
        ]
        # Clé : rule_id seul. Une nouvelle version remplace la précédente dans la ligne ; l'historique
        # des versions reste dans la base de la plateforme (rule_versions).
        sql = f"""
        MERGE {self.ds}.rules_registry t
        USING (SELECT @rule_id AS rule_id) s
        ON t.rule_id = s.rule_id
        WHEN MATCHED THEN UPDATE SET
          version = @version, name = @name, description = @description,
          fraud_typology = @fraud_typology, criticality = @criticality, schedule = @schedule,
          sql_query = @sql_query, status = @status, updated_at = @updated_at
        WHEN NOT MATCHED THEN INSERT
          (rule_id, version, name, description, fraud_typology, criticality, schedule, sql_query,
           status, owner_matricule, created_at, updated_at)
        VALUES (@rule_id, @version, @name, @description, @fraud_typology, @criticality, @schedule,
                @sql_query, @status, @owner_matricule, @created_at, @updated_at)
        """
        self.client.query(sql, job_config=self._bq.QueryJobConfig(query_parameters=params)).result()


def _jsonable(v: Any) -> Any:
    if isinstance(v, str | int | float | bool) or v is None:
        return v
    return str(v)


# ---------------------------------------------------------------------------
# Implémentation factice (développement local et tests, sans GCP)
# ---------------------------------------------------------------------------


@dataclass
class FakeBigQueryGateway:
    """Simule un dry-run réussi sur toute requête commençant par SELECT/WITH.

    Les tests peuvent pré-remplir `next_dry_run` / `next_error` pour forcer un cas.
    """

    bytes_processed: int = 6 * 10**9
    next_dry_run: DryRunMeta | None = None
    next_error: QueryError | None = None
    performance: dict[str, list[DailyPerformance]] = field(default_factory=dict)
    # Contenu simulé de rules_registry : rule_id → (version, statut).
    registry: dict[str, tuple[int, str]] = field(default_factory=dict)
    stats: list[RunStats] = field(default_factory=list)

    def dry_run(self, sql, run_date):
        if self.next_error:
            err, self.next_error = self.next_error, None
            raise err
        if self.next_dry_run:
            meta, self.next_dry_run = self.next_dry_run, None
            return meta
        m = re.match(r"\s*(\w+)", sql)
        first = m.group(1).upper() if m else "UNKNOWN"
        stype = "SELECT" if first in ("SELECT", "WITH") else first
        cols = (
            [Column(name="order_id", type="STRING")]
            if "order_id" in sql
            else [Column(name="f0_", type="STRING")]
        )
        return DryRunMeta(stype, self.bytes_processed, cols)

    def execute(self, sql, run_date):
        meta = self.dry_run(sql, run_date)
        cols = [c.name for c in meta.schema]
        rows = [{c: f"{c}-{i}" for c in cols} for i in range(5)]
        return ExecMeta(cols, rows, total_rows=5, duration_ms=1200, bytes_processed=meta.bytes_processed)

    def daily_performance(self, rule_id, start, end):
        return [d for d in self.performance.get(rule_id, []) if start <= d.date <= end]

    def runs(self, rule_id, start, end, limit=20):
        return []

    def version_totals(self, rule_id):
        by: dict[int, list[DailyPerformance]] = {}
        for d in self.performance.get(rule_id, []):
            by.setdefault(d.rule_version or 0, []).append(d)
        return [
            VersionPerformance(
                version=v,
                first_date=min(d.date for d in ds),
                last_date=max(d.date for d in ds),
                days=len(ds),
                orders_flagged=sum(d.orders_flagged for d in ds),
                orders_processed=sum(d.orders_processed for d in ds),
                orders_confirmed_fraud=sum(d.orders_confirmed_fraud for d in ds),
            )
            for v, ds in sorted(by.items())
        ]

    def production_totals(self, rule_ids, start, end):
        out = []
        for rid in rule_ids:
            d = self.daily_performance(rid, start, end)
            out.append(
                ProductionTotals(
                    rid,
                    sum(x.orders_flagged for x in d),
                    sum(x.orders_processed for x in d),
                    sum(x.orders_confirmed_fraud for x in d),
                )
            )
        return out

    def run_stats(self):
        return list(self.stats)

    def upsert_rule(self, rule, v, status):
        log.info("rules_registry ← %s v%s (%s)", v.rule_id, v.version, status)
        self.registry[v.rule_id] = (v.version, status)

    def delete_rule(self, rule_id):
        log.info("rules_registry ✕ %s", rule_id)
        self.registry.pop(rule_id, None)


@lru_cache
def _gateway() -> BigQueryGateway:
    s = get_settings()
    return RealBigQueryGateway(s) if s.bigquery_mode == "real" else FakeBigQueryGateway()


def get_bigquery() -> BigQueryGateway:
    return _gateway()
