from app.schemas import RuleParameter
from app.sql_checks import check_params, find_params, query_hash


def test_params_ignores_dans_chaines_et_commentaires():
    sql = (
        "SELECT order_id FROM t -- @nope\nWHERE a = '@str' AND d = @run_date AND x > @seuil AND @@project_id"
    )
    assert [n for n, _ in find_params(sql)] == ["run_date", "seuil"]


def test_param_reserve_et_inutilise():
    p = [RuleParameter(name="run_date", type="DATE"), RuleParameter(name="b", type="INT64")]
    codes = {i.code for i in check_params("SELECT order_id WHERE x = @run_date", p)}
    assert codes == {"PARAM_RESERVED", "PARAM_UNUSED"}


def test_query_hash_identique_au_front():
    # Valeurs calculées avec queryHash() de frontend/src/lib/sql.ts.
    assert query_hash("SELECT 1", []) == query_hash("  SELECT   1\n", [])
    assert query_hash("SELECT 1", []) == "32397c4a"
    assert query_hash("SELECT é", [RuleParameter(name="a", type="INT64", default="5")]) == "a2222771"
