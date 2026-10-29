-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme,
-- consommée par l'équipe data et Airflow. UNE LIGNE PAR RÈGLE, mise à jour (MERGE sur rule_id) à chaque
-- soumission : elle porte la dernière version soumise, celle qu'Airflow exécute. Le DAG lit à chaque run
--   SELECT sql_query, version FROM rules_registry WHERE rule_id = @rule_id
-- et écrit `version` dans rule_runs. L'historique des versions et les brouillons restent dans la base de
-- la plateforme ; une version reprise en brouillon avant tout run ramène la ligne à la version précédente.
-- Écarts au PRD : owner_matricule au lieu de owner_email (le matricule est la clé d'identité, PRD §5.4) ;
-- pas de colonne parameters : la requête s'exécute telle quelle (seuils en dur, dates via CURRENT_DATE()).
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rules_registry` (
  rule_id          STRING    NOT NULL,   -- UUID, stable entre versions
  version          INT64     NOT NULL,
  name             STRING    NOT NULL,
  description      STRING    NOT NULL,
  fraud_typology   STRING    NOT NULL,
  criticality      STRING    NOT NULL,   -- HIGH | MEDIUM | LOW
  schedule         STRING    NOT NULL,   -- DAILY | HOURLY | WEEKLY
  sql_query        STRING    NOT NULL,
  status           STRING    NOT NULL,   -- SUBMITTED | IN_PRODUCTION | INACTIVE
                                         -- (les deux derniers sont déduits des exécutions dans rule_runs)
  owner_matricule  STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL,   -- création de la règle
  updated_at       TIMESTAMP NOT NULL    -- dernière soumission
)
CLUSTER BY rule_id;
