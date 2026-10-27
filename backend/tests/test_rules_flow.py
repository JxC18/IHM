from datetime import UTC, date, datetime, timedelta

from app.bigquery import DryRunMeta, QueryError, RunStats
from app.schemas import Column, DailyPerformance
from tests.conftest import login

SQL = """SELECT
  o.order_id
FROM `sales.orders` o
WHERE o.order_date = @run_date
  AND o.amount_eur > 500"""
RULE = {
    "name": "Panier élevé",
    "description": "Commandes au-dessus du seuil",
    "fraudTypology": "Fraude au moyen de paiement",
    "criticality": "HIGH",
    "schedule": "DAILY",
    "sqlQuery": SQL,
}


def test_parcours_complet_creation_test_soumission(client, bq):
    login(client)
    rule = client.post("/rules", json=RULE).json()
    rid = rule["ruleId"]
    assert rule["status"] == "DRAFT" and rule["version"] == 1

    # Soumission refusée sans test.
    r = client.post(f"/rules/{rid}/submit")
    assert r.status_code == 409 and r.json()["code"] == "TEST_REQUIRED"

    dry = client.post("/query/dry-run", json={"sql": SQL, "ruleId": rid}).json()
    assert dry["ok"] is True, dry["issues"]
    ex = client.post("/query/execute", json={"sql": SQL, "ruleId": rid}).json()
    assert ex["ok"] is True and ex["totalRows"] == 5

    r = client.post(f"/rules/{rid}/submit")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "SUBMITTED"
    assert bq.published[-1] == (rid, 1, "SUBMITTED")

    # Soumise mais jamais exécutée par Airflow : modifiable sur place, elle repasse en brouillon.
    r = client.put(f"/rules/{rid}", json={**RULE, "description": "v1 corrigée"}).json()
    assert (r["version"], r["status"], r["versionCount"]) == (1, "DRAFT", 1)
    assert bq.published[-1] == (rid, 1, "DRAFT")

    # Les lignes ne sont jamais persistées : seules les métadonnées apparaissent.
    tests = client.get(f"/rules/{rid}").json()["tests"]
    assert {t["phase"] for t in tests} == {"DRY_RUN", "EXECUTION"}
    assert all("rows" not in t for t in tests)

    actions = [e["action"] for e in client.get("/audit", params={"ruleId": rid}).json()]
    assert {"RULE_CREATE", "RULE_TEST", "RULE_SUBMIT", "RULE_UPDATE"} <= set(actions)


def test_test_sur_ancienne_requete_ne_permet_pas_la_soumission(client):
    login(client)
    rid = client.post("/rules", json=RULE).json()["ruleId"]
    client.post("/query/execute", json={"sql": SQL, "ruleId": rid})
    client.put(f"/rules/{rid}", json={**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"})
    assert client.post(f"/rules/{rid}/submit").status_code == 409


def test_tests_avant_premier_enregistrement_sont_rattaches(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL})
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
    assert {"NO_ORDER_ID", "HARDCODED_DATE", "PARAM_NOT_ALLOWED", "RUN_DATE_MISSING"} <= codes


def test_erreur_bigquery_avec_position(client, bq):
    login(client)
    bq.next_error = QueryError("Not found: Table p.sales.nope was not found at [3:6]")
    issue = client.post("/query/dry-run", json={"sql": SQL}).json()["issues"][0]
    assert (issue["code"], issue["line"], issue["column"]) == ("BIGQUERY", 3, 6)


def test_plafond_de_volume(client, bq):
    login(client)
    bq.bytes_processed = 60 * 10**9
    dry = client.post("/query/dry-run", json={"sql": SQL}).json()
    assert dry["exceedsBytesLimit"] is True
    r = client.post("/query/execute", json={"sql": SQL})
    assert r.status_code == 422 and r.json()["code"] == "BYTES_LIMIT"


def test_budget_comptabilise_les_executions(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL})
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


def _submit(client, rule=RULE):
    rid = client.post("/rules", json=rule).json()["ruleId"]
    client.post("/query/execute", json={"sql": rule["sqlQuery"], "ruleId": rid})
    assert client.post(f"/rules/{rid}/submit").status_code == 200
    return rid


def test_statuts_deduits_des_runs_airflow(client, bq):
    login(client)
    rid = _submit(client)
    status = lambda: client.get(f"/rules/{rid}").json()["status"]  # noqa: E731
    assert status() == "SUBMITTED"

    # Airflow exécute la v1 : la plateforme la constate en production.
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now - timedelta(days=10), now - timedelta(hours=2), "fraud_rule_v1")]
    assert client.post("/internal/sync-runs").json() == {"rulesUpdated": 1}
    detail = client.get(f"/rules/{rid}").json()
    assert detail["status"] == "IN_PRODUCTION" and detail["airflowDagId"] == "fraud_rule_v1"
    assert [r["ruleId"] for r in client.get("/performance/production").json()] == [rid]

    # Plus de run depuis 4 jours pour une règle quotidienne : inactive.
    bq.stats = [RunStats(rid, 1, now - timedelta(days=10), now - timedelta(days=4), "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    assert status() == "INACTIVE"
    # Rien de nouveau dans rule_runs : rien à republier.
    assert client.post("/internal/sync-runs").json() == {"rulesUpdated": 0}
    assert client.get("/performance/production").json()[0]["status"] == "INACTIVE"

    # Une v2 est soumise : la v1 tourne encore, elle reste visible comme version en production.
    client.put(f"/rules/{rid}", json={**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"})
    client.post("/query/execute", json={"sql": SQL + "\n  AND o.item_count > 1", "ruleId": rid})
    client.post(f"/rules/{rid}/submit")
    d = client.get(f"/rules/{rid}").json()
    assert (d["status"], d["productionVersion"]) == ("SUBMITTED", 1)

    # La v2 démarre : la v1 est remplacée.
    bq.stats.append(RunStats(rid, 2, now, now, "fraud_rule_v2"))
    client.post("/internal/sync-runs")
    d = client.get(f"/rules/{rid}").json()
    assert [v["status"] for v in d["versions"]] == ["IN_PRODUCTION", "REPLACED"]
    assert bq.published[-2:] == [(rid, 1, "REPLACED"), (rid, 2, "IN_PRODUCTION")]


def test_version_qui_a_tourne_reste_figee(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    r = client.put(f"/rules/{rid}", json={**RULE, "description": "seuil revu"}).json()
    assert (r["version"], r["status"], r["productionVersion"]) == (2, "DRAFT", 1)


def test_performance_par_version(client, bq):
    login(client)
    rid = _submit(client)
    day = date.today() - timedelta(days=3)
    bq.performance[rid] = [
        DailyPerformance(
            date=day, rule_version=1, orders_flagged=40, orders_processed=30, orders_confirmed_fraud=6
        ),
        DailyPerformance(
            date=day + timedelta(days=1),
            rule_version=2,
            orders_flagged=10,
            orders_processed=10,
            orders_confirmed_fraud=5,
        ),
    ]
    r = client.get(f"/rules/{rid}/performance", params={"from": str(day), "to": str(date.today())}).json()
    assert [d["ruleVersion"] for d in r["daily"]] == [1, 2]
    assert [(v["version"], v["ordersFlagged"], v["ordersConfirmedFraud"]) for v in r["versions"]] == [
        (1, 40, 6),
        (2, 10, 5),
    ]
