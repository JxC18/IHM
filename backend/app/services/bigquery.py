"""Accès BigQuery. Seul module à détenir un client (le front n'a jamais de credentials, PRD §8.1).

Les garde-fous F3 sont posés ici, côté serveur, donc non contournables depuis l'IHM :
`maximum_bytes_billed`, `job_timeout_ms`, `max_results`.
"""

import re
import time
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Any, Protocol

from app.config import Settings, get_settings
from app.schemas import Column, DailyPerformance, RuleParameter, RuleRun


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
class ProductionTotals:
    rule_id: str
    flagged: int
    processed: int
    confirmed: int


class BigQueryGateway(Protocol):
    def dry_run(self, sql: str, params: list[RuleParameter], run_date: date) -> DryRunMeta: ...

    def execute(self, sql: str, params: list[RuleParameter], run_date: date) -> ExecMeta: ...

    def daily_performance(self, rule_id: str, start: date, end: date) -> list[DailyPerformance]: ...

    def runs(self, rule_id: str, start: date, end: date, limit: int = 20) -> list[RuleRun]: ...

    def production_totals(self, rule_ids: list[str], start: date, end: date) -> list[ProductionTotals]: ...


# ---------------------------------------------------------------------------
# Implémentation réelle
# ---------------------------------------------------------------------------


def _bq_param(p: RuleParameter):
    from google.cloud import bigquery

    v: Any = p.default
    if p.type == "INT64":
        v = int(v) if v != "" else None
    elif p.type == "FLOAT64":
        v = float(v) if v != "" else None
    elif p.type == "BOOL":
        v = v.lower() in ("true", "1", "oui") if v != "" else None
    elif p.type == "DATE":
        v = date.fromisoformat(v) if v else None
    return bigquery.ScalarQueryParameter(p.name, p.type, v)


class RealBigQueryGateway:
    def __init__(self, settings: Settings):
        from google.cloud import bigquery

        self._bq = bigquery
        self.settings = settings
        self.client = bigquery.Client(project=settings.gcp_project or None, location=settings.bq_location)
        self.ds = f"`{self.client.project}.{settings.bq_dataset}`"

    def _config(self, params: list[RuleParameter], run_date: date, **kw):
        qp = [_bq_param(p) for p in params] + [self._bq.ScalarQueryParameter("run_date", "DATE", run_date)]
        return self._bq.QueryJobConfig(
            query_parameters=qp, use_query_cache=False, labels={"app": "rules-manager"}, **kw
        )

    def dry_run(self, sql, params, run_date):
        from google.api_core.exceptions import GoogleAPICallError

        try:
            job = self.client.query(sql, job_config=self._config(params, run_date, dry_run=True))
        except GoogleAPICallError as e:
            raise QueryError(getattr(e, "message", str(e))) from e
        schema = [Column(name=f.name, type=f.field_type) for f in (job.schema or [])]
        return DryRunMeta(job.statement_type or "UNKNOWN", job.total_bytes_processed or 0, schema)

    def execute(self, sql, params, run_date):
        from google.api_core.exceptions import GoogleAPICallError

        cfg = self._config(params, run_date, maximum_bytes_billed=self.settings.max_bytes_billed)
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
            f"""SELECT run_date, orders_flagged, orders_processed, orders_confirmed_fraud
                FROM {self.ds}.v_rule_performance
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end
                ORDER BY run_date""",
            [P("rule_id", "STRING", rule_id), P("start", "DATE", start), P("end", "DATE", end)],
        )
        return [
            DailyPerformance(
                date=r["run_date"],
                orders_flagged=r["orders_flagged"],
                orders_processed=r["orders_processed"],
                orders_confirmed_fraud=r["orders_confirmed_fraud"],
            )
            for r in rows
        ]

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

    def dry_run(self, sql, params, run_date):
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

    def execute(self, sql, params, run_date):
        meta = self.dry_run(sql, params, run_date)
        cols = [c.name for c in meta.schema]
        rows = [{c: f"{c}-{i}" for c in cols} for i in range(5)]
        return ExecMeta(cols, rows, total_rows=5, duration_ms=1200, bytes_processed=meta.bytes_processed)

    def daily_performance(self, rule_id, start, end):
        return [d for d in self.performance.get(rule_id, []) if start <= d.date <= end]

    def runs(self, rule_id, start, end, limit=20):
        return []

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


@lru_cache
def _gateway() -> BigQueryGateway:
    s = get_settings()
    return RealBigQueryGateway(s) if s.bigquery_mode == "real" else FakeBigQueryGateway()


def get_bigquery() -> BigQueryGateway:
    return _gateway()
