-- Trace d'exécution d'un DAG (PRD §7.2). Écrite par Airflow.
-- C'est d'ici que la plateforme déduit qu'une version est en production, inactive ou remplacée :
-- l'équipe data n'a aucune action à faire sur la plateforme.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_runs` (
  run_id        STRING    NOT NULL,
  rule_id       STRING    NOT NULL,
  rule_version  INT64     NOT NULL,
  airflow_dag_id STRING   NOT NULL,      -- DAG qui exécute la règle
  run_date      DATE      NOT NULL,
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,
  status        STRING    NOT NULL,      -- SUCCESS | FAILED
  rows_returned INT64,
  error_message STRING
)
PARTITION BY run_date;
