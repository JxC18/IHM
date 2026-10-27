-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme,
-- consommée par l'équipe data et Airflow.
-- Écarts au PRD : owner_matricule au lieu de owner_email (le matricule est la clé d'identité, PRD §5.4) ;
-- pas de colonne parameters : les seuils sont écrits dans sql_query, seul @run_date est fourni par Airflow.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rules_registry` (
  rule_id          STRING    NOT NULL,   -- UUID, stable entre versions
  version          INT64     NOT NULL,
  name             STRING    NOT NULL,
  description      STRING    NOT NULL,
  fraud_typology   STRING    NOT NULL,
  criticality      STRING    NOT NULL,   -- HIGH | MEDIUM | LOW
  schedule         STRING    NOT NULL,   -- DAILY | HOURLY | WEEKLY
  sql_query        STRING    NOT NULL,
  status           STRING    NOT NULL,   -- DRAFT | SUBMITTED | IN_PRODUCTION | INACTIVE | REPLACED
                                         -- (les trois derniers sont déduits des exécutions dans rule_runs)
  owner_matricule  STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(created_at);
