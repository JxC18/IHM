"""Exposition des règles à l'équipe data et à Airflow via `rules_registry` (PRD §7.2, §8.3).

Deux options restent ouvertes (PRD Q1) :
  - vue fédérée `EXTERNAL_QUERY` sur Cloud SQL : rien à faire ici (LoggingRegistry) ;
  - synchronisation à l'écriture : BigQueryRegistry pousse chaque version par MERGE.
"""

import logging
from functools import lru_cache
from typing import Protocol

from app.config import get_settings
from app.models import RuleVersion

log = logging.getLogger(__name__)


class Registry(Protocol):
    def upsert(self, v: RuleVersion, owner_matricule: str) -> None: ...


class LoggingRegistry:
    def upsert(self, v: RuleVersion, owner_matricule: str) -> None:
        log.info("rules_registry ← %s v%s (%s)", v.rule_id, v.version, v.status)


class BigQueryRegistry:
    def __init__(self) -> None:
        from google.cloud import bigquery

        s = get_settings()
        self._bq = bigquery
        self.client = bigquery.Client(project=s.gcp_project or None, location=s.bq_location)
        self.table = f"`{self.client.project}.{s.bq_dataset}.rules_registry`"

    def upsert(self, v: RuleVersion, owner_matricule: str) -> None:
        import json

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
            P("parameters", "STRING", json.dumps(v.parameters)),
            P("status", "STRING", v.status),
            P("owner_matricule", "STRING", owner_matricule),
            P("created_at", "TIMESTAMP", v.created_at),
            P("updated_at", "TIMESTAMP", v.updated_at),
        ]
        sql = f"""
        MERGE {self.table} t
        USING (SELECT @rule_id AS rule_id, @version AS version) s
        ON t.rule_id = s.rule_id AND t.version = s.version
        WHEN MATCHED THEN UPDATE SET
          name = @name, description = @description, fraud_typology = @fraud_typology,
          criticality = @criticality, schedule = @schedule, sql_query = @sql_query,
          parameters = PARSE_JSON(@parameters), status = @status, updated_at = @updated_at
        WHEN NOT MATCHED THEN INSERT
          (rule_id, version, name, description, fraud_typology, criticality, schedule, sql_query,
           parameters, status, owner_matricule, created_at, updated_at)
        VALUES (@rule_id, @version, @name, @description, @fraud_typology, @criticality, @schedule,
                @sql_query, PARSE_JSON(@parameters), @status, @owner_matricule, @created_at, @updated_at)
        """
        self.client.query(sql, job_config=self._bq.QueryJobConfig(query_parameters=params)).result()


@lru_cache
def _registry() -> Registry:
    return BigQueryRegistry() if get_settings().bigquery_mode == "real" else LoggingRegistry()


def get_registry() -> Registry:
    return _registry()
