-- Commandes remontées par une règle (PRD §7.2). Écrite par Airflow. LE CONTRAT.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_alerts` (
  rule_id      STRING    NOT NULL,
  rule_version INT64     NOT NULL,
  run_id       STRING    NOT NULL,
  run_date     DATE      NOT NULL,
  order_id     STRING    NOT NULL,
  detected_at  TIMESTAMP NOT NULL,
  -- Autres colonnes renvoyées par la règle pour cette commande (montant, BIN…), écrites telles
  -- quelles par Airflow. Chaque règle a ses propres colonnes : un JSON garde le schéma commun.
  -- Facultatif : un DAG qui ne la remplit pas reste conforme. Les indicateurs n'en dépendent pas.
  details      JSON
)
PARTITION BY run_date
CLUSTER BY rule_id;
