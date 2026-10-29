from app.sql_checks import check_params, find_params, query_hash


def test_params_ignores_dans_chaines_et_commentaires():
    sql = (
        "SELECT order_id FROM t -- @nope\nWHERE a = '@str' AND d = @run_date AND x > @seuil AND @@project_id"
    )
    assert [n for n, _ in find_params(sql)] == ["run_date", "seuil"]


def test_aucun_parametre_autorise():
    # La requête s'exécute telle quelle : tout paramètre est refusé, @run_date compris.
    codes = [i.code for i in check_params("SELECT order_id WHERE x > @seuil AND d = @run_date")]
    assert codes == ["PARAM_NOT_ALLOWED", "PARAM_NOT_ALLOWED"]
    assert check_params("SELECT order_id FROM t WHERE d = CURRENT_DATE()") == []


def test_query_hash_identique_au_front():
    # Valeurs calculées avec queryHash() de frontend/src/lib/sql.ts.
    assert query_hash("SELECT 1") == query_hash("  SELECT   1\n")
    assert query_hash("SELECT 1") == "bce9e8b2"
    assert query_hash("SELECT é FROM t WHERE d = @run_date") == "5f48a2f4"
