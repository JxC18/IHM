-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme,
-- consommée par l'équipe data et Airflow.
-- Écart au PRD : owner_matricule au lieu de owner_email (le matricule est la clé d'identité, PRD §5.4).
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rules_registry` (
  rule_id          STRING    NOT NULL,   -- UUID, stable entre versions
  version          INT64     NOT NULL,
  name             STRING    NOT NULL,
  description      STRING    NOT NULL,
  fraud_typology   STRING    NOT NULL,
  criticality      STRING    NOT NULL,   -- HIGH | MEDIUM | LOW
  schedule         STRING    NOT NULL,   -- DAILY | HOURLY | WEEKLY
  sql_query        STRING    NOT NULL,
  parameters       JSON,                 -- [{name, type, default, description}]
  status           STRING    NOT NULL,   -- DRAFT | SUBMITTED | VALIDATED | IN_PRODUCTION | DISABLED | REJECTED
  rejection_reason STRING,
  owner_matricule  STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL,
  airflow_dag_id   STRING                -- renseigné par l'équipe data
)
PARTITION BY DATE(created_at);
