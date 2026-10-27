from app.schemas import Column
from app.services.bigquery import DryRunMeta, QueryError
from tests.conftest import login

SQL = """SELECT
  o.order_id
FROM `sales.orders` o
WHERE o.order_date = @run_date
  AND o.amount_eur > @seuil"""
PARAMS = [{"name": "seuil", "type": "FLOAT64", "default": "500", "description": "Montant"}]
RULE = {
    "name": "Panier élevé",
    "description": "Commandes au-dessus du seuil",
    "fraudTypology": "Fraude au moyen de paiement",
    "criticality": "HIGH",
    "schedule": "DAILY",
    "sqlQuery": SQL,
    "parameters": PARAMS,
}


def test_parcours_complet_creation_test_soumission(client, registry):
    login(client)
    rule = client.post("/rules", json=RULE).json()
    rid = rule["ruleId"]
    assert rule["status"] == "DRAFT" and rule["version"] == 1

    # Soumission refusée sans test.
    r = client.post(f"/rules/{rid}/submit")
    assert r.status_code == 409 and r.json()["code"] == "TEST_REQUIRED"

    dry = client.post("/query/dry-run", json={"sql": SQL, "parameters": PARAMS, "ruleId": rid}).json()
    assert dry["ok"] is True, dry["issues"]
    ex = client.post("/query/execute", json={"sql": SQL, "parameters": PARAMS, "ruleId": rid}).json()
    assert ex["ok"] is True and ex["totalRows"] == 5

    r = client.post(f"/rules/{rid}/submit")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "SUBMITTED"
    assert registry.upserts[-1] == (rid, 1, "SUBMITTED")

    # Une règle soumise n'est plus modifiable : nouvelle version en DRAFT.
    r = client.put(f"/rules/{rid}", json={**RULE, "description": "v2"}).json()
    assert r["version"] == 2 and r["status"] == "DRAFT"
    assert [v["status"] for v in r["versions"]] == ["DRAFT", "SUBMITTED"]

    # Les lignes ne sont jamais persistées : seules les métadonnées apparaissent.
    tests = client.get(f"/rules/{rid}").json()["tests"]
    assert {t["phase"] for t in tests} == {"DRY_RUN", "EXECUTION"}
    assert all("rows" not in t for t in tests)

    actions = [e["action"] for e in client.get("/audit", params={"ruleId": rid}).json()]
    assert {"RULE_CREATE", "RULE_TEST", "RULE_SUBMIT", "RULE_NEW_VERSION"} <= set(actions)


def test_test_sur_ancienne_requete_ne_permet_pas_la_soumission(client):
    login(client)
    rid = client.post("/rules", json=RULE).json()["ruleId"]
    client.post("/query/execute", json={"sql": SQL, "parameters": PARAMS, "ruleId": rid})
    client.put(f"/rules/{rid}", json={**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"})
    assert client.post(f"/rules/{rid}/submit").status_code == 409


def test_tests_avant_premier_enregistrement_sont_rattaches(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL, "parameters": PARAMS})
    rid = client.post("/rules", json=RULE).json()["ruleId"]
    assert client.post(f"/rules/{rid}/submit").status_code == 200


def test_nom_unique_insensible_casse_et_accents(client):
    login(client)
    client.post("/rules", json=RULE)
    r = client.post("/rules", json={**RULE, "name": "PANIER ELEVE"})
    assert r.status_code == 409 and r.json()["code"] == "NAME_TAKEN"
    assert client.get("/rules/name-available", params={"name": "panier élevé"}).json() == {"available": False}


def test_dml_refuse_a_l_enregistrement(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("DELETE", 0, [])
    r = client.post("/rules", json={**RULE, "sqlQuery": "DELETE FROM `sales.orders` WHERE true"})
    assert r.status_code == 422 and r.json()["code"] == "NOT_SELECT"


def test_dry_run_controles(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("SELECT", 10**9, [Column(name="customer_id", type="STRING")])
    sql = "SELECT customer_id FROM t WHERE d = DATE '2026-01-01' AND x = @inconnu"
    codes = {i["code"] for i in client.post("/query/dry-run", json={"sql": sql}).json()["issues"]}
    assert {"NO_ORDER_ID", "HARDCODED_DATE", "PARAM_UNDECLARED", "RUN_DATE_MISSING"} <= codes


def test_erreur_bigquery_avec_position(client, bq):
    login(client)
    bq.next_error = QueryError("Not found: Table p.sales.nope was not found at [3:6]")
    issue = client.post("/query/dry-run", json={"sql": SQL, "parameters": PARAMS}).json()["issues"][0]
    assert (issue["code"], issue["line"], issue["column"]) == ("BIGQUERY", 3, 6)


def test_plafond_de_volume(client, bq):
    login(client)
    bq.bytes_processed = 60 * 10**9
    dry = client.post("/query/dry-run", json={"sql": SQL, "parameters": PARAMS}).json()
    assert dry["exceedsBytesLimit"] is True
    r = client.post("/query/execute", json={"sql": SQL, "parameters": PARAMS})
    assert r.status_code == 422 and r.json()["code"] == "BYTES_LIMIT"


def test_budget_comptabilise_les_executions(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL, "parameters": PARAMS})
    assert client.get("/me/budget").json()["bytesUsed"] == 6 * 10**9


def test_filtres_et_recherche(client):
    login(client)
    client.post("/rules", json=RULE)
    client.post(
        "/rules", json={**RULE, "name": "Autre", "criticality": "LOW", "sqlQuery": SQL + " -- relais"}
    )
    assert len(client.get("/rules").json()) == 2
    assert [r["name"] for r in client.get("/rules", params={"criticality": "LOW"}).json()] == ["Autre"]
    assert [r["name"] for r in client.get("/rules", params={"q": "RELAIS"}).json()] == ["Autre"]
    assert client.get("/rules", params={"status": "SUBMITTED"}).json() == []
