-- Version à exécuter pour chaque règle : la dernière version soumise (contrat Airflow).
-- Le DAG lit ici la requête à chaque run, par rule_id :
--   SELECT sql_query, version FROM v_rules_active WHERE rule_id = @rule_id
-- Une nouvelle version soumise est donc exécutée dès le run suivant, sans action de l'équipe data ;
-- les brouillons (dont une version soumise reprise pour modification) ne sont jamais exécutés.
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rules_active` AS
SELECT rule_id, version, name, schedule, sql_query
FROM `${PROJECT}.${DATASET}.rules_registry`
WHERE status != 'DRAFT'
QUALIFY ROW_NUMBER() OVER (PARTITION BY rule_id ORDER BY version DESC) = 1;
