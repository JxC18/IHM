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


def test_parcours_complet_brouillon_test_soumission(client, bq):
    login(client)
    d = client.post("/drafts", json=RULE).json()
    did, rid = d["id"], d["ruleId"]
    assert d["newRule"] is True and d["baseVersion"] is None
    # Tant qu'elle n'est pas soumise, la règle n'est pas dans le référentiel partagé.
    assert client.get("/rules").json() == []
    assert client.get(f"/rules/{rid}").status_code == 404

    # Soumission refusée sans test.
    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 409 and r.json()["code"] == "TEST_REQUIRED"

    dry = client.post("/query/dry-run", json={"sql": SQL, "draftId": did}).json()
    assert dry["ok"] is True, dry["issues"]
    ex = client.post("/query/execute", json={"sql": SQL, "draftId": did}).json()
    assert ex["ok"] is True and ex["totalRows"] == 5
    assert client.get(f"/drafts/{did}").json()["lastTest"]["phase"] == "EXECUTION"

    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 200, r.text
    rule = r.json()
    assert (rule["ruleId"], rule["version"], rule["status"]) == (rid, 1, "SUBMITTED")
    assert rule["submittedByName"] == "Camille Martin"
    assert bq.registry == {rid: (1, "SUBMITTED")}  # le brouillon n'a jamais été publié
    assert client.get("/drafts").json() == []  # le brouillon est devenu la v1

    # Les tests du brouillon suivent la version ; les lignes ne sont jamais persistées.
    tests = rule["tests"]
    assert {t["phase"] for t in tests} == {"DRY_RUN", "EXECUTION"} and all(t["version"] == 1 for t in tests)
    assert all("rows" not in t for t in tests)

    # Soumise mais jamais exécutée par Airflow : son auteur peut la reprendre, elle redevient son brouillon.
    assert rule["canWithdraw"] is True
    d = client.post("/drafts", json={**RULE, "description": "v1 corrigée", "ruleId": rid}).json()
    assert (d["withdrawn"], d["ruleId"], d["newRule"]) == (True, rid, True)
    # Elle sort de rules_registry (Airflow ne peut plus la prendre) et du référentiel.
    assert rid not in bq.registry
    assert client.get(f"/rules/{rid}").status_code == 404
    # Ses tests l'ont suivie : description seule modifiée, la requête testée est toujours valable.
    assert client.post(f"/drafts/{d['id']}/submit").json()["version"] == 1

    actions = [e["action"] for e in client.get("/audit", params={"ruleId": rid}).json()]
    assert actions.count("RULE_SUBMIT") == 2 and "RULE_WITHDRAW" in actions


def test_brouillon_invisible_des_collegues(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    client.post("/query/execute", json={"sql": SQL, "draftId": did})
    login(client, "200001", "Sacha", "Bernard")
    assert client.get("/drafts").json() == []
    assert client.get(f"/drafts/{did}").status_code == 404
    assert client.put(f"/drafts/{did}", json=RULE).status_code == 404
    assert client.post(f"/drafts/{did}/submit").status_code == 404
    assert client.post("/query/execute", json={"sql": SQL, "draftId": did}).status_code == 404
    # Le journal garde la trace du test (volume scanné) sans rien dire du brouillon.
    ev = [e for e in client.get("/audit").json() if e["action"] == "RULE_TEST"]
    assert ev and all(e["ruleId"] is None and e["ruleName"] is None for e in ev)


def test_nouvelle_version_en_brouillon_ne_change_pas_la_regle_pour_les_autres(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    d = client.post("/drafts", json={**RULE, "description": "seuil revu", "ruleId": rid}).json()
    assert (d["baseVersion"], d["withdrawn"], d["latestVersion"]) == (1, False, 1)
    assert client.get(f"/rules/{rid}").json()["myDraftId"] == d["id"]
    # Un seul brouillon par règle et par personne.
    r = client.post("/drafts", json={**RULE, "ruleId": rid})
    assert r.status_code == 409 and r.json()["code"] == "DRAFT_EXISTS"

    login(client, "200001", "Sacha", "Bernard")
    rule = client.get(f"/rules/{rid}").json()
    assert (rule["versionCount"], rule["description"], rule["myDraftId"]) == (1, RULE["description"], None)
    assert rule["canWithdraw"] is False
    # Un collègue peut préparer sa propre version en parallèle ; la première soumise prend la v2.
    other = client.post("/drafts", json={**RULE, "description": "autre piste", "ruleId": rid}).json()
    client.post("/query/execute", json={"sql": SQL, "draftId": other["id"]})
    assert client.post(f"/drafts/{other['id']}/submit").json()["version"] == 2

    login(client)
    d = client.get(f"/drafts/{d['id']}").json()
    assert (d["baseVersion"], d["latestVersion"]) == (1, 2)  # l'éditeur signale le décalage


def test_suppression_d_un_brouillon(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    assert client.delete(f"/drafts/{did}").status_code == 204
    assert client.get("/drafts").json() == []


def test_test_sur_ancienne_requete_ne_permet_pas_la_soumission(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    client.post("/query/execute", json={"sql": SQL, "draftId": did})
    client.put(f"/drafts/{did}", json={**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"})
    assert client.post(f"/drafts/{did}/submit").status_code == 409


def test_tests_avant_premier_enregistrement_sont_rattaches(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL})
    did = client.post("/drafts", json=RULE).json()["id"]
    assert client.post(f"/drafts/{did}/submit").status_code == 200


def test_nom_unique_insensible_casse_et_accents(client):
    login(client)
    _submit(client)
    r = client.post("/drafts", json={**RULE, "name": "PANIER ELEVE"})
    assert r.status_code == 409 and r.json()["code"] == "NAME_TAKEN"
    assert client.get("/rules/name-available", params={"name": "panier élevé"}).json() == {"available": False}


def test_dml_refuse_a_l_enregistrement(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("DELETE", 0, [])
    r = client.post("/drafts", json={**RULE, "sqlQuery": "DELETE FROM `sales.orders` WHERE true"})
    assert r.status_code == 422 and r.json()["code"] == "NOT_SELECT"


def test_dry_run_controles(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("SELECT", 10**9, [Column(name="customer_id", type="STRING")])
    sql = "SELECT customer_id FROM t WHERE d = DATE '2026-01-01' AND x = @inconnu"
    dry = client.post("/query/dry-run", json={"sql": sql}).json()
    issues = {i["code"]: i["severity"] for i in dry["issues"]}
    assert issues["NO_ORDER_ID"] == issues["PARAM_NOT_ALLOWED"] == "error"
    # Une date en dur n'empêche pas de tester ; @run_date est facultatif.
    assert issues["HARDCODED_DATE"] == "warning" and "RUN_DATE_MISSING" not in issues


def test_date_en_dur_et_sans_run_date_soumissibles(client):
    login(client)
    # Seuil de date fixe : légitime, la requête se teste et se soumet.
    _submit(client, {**RULE, "sqlQuery": SQL + "\n  AND o.created_at >= TIMESTAMP '2024-01-01'"})
    # Sans @run_date : se teste et se soumet aussi.
    sans = "SELECT o.order_id FROM `sales.orders` o WHERE o.order_date = CURRENT_DATE()"
    _submit(client, {**RULE, "name": "Sans run_date", "sqlQuery": sans})


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
    _submit(client)
    _submit(client, {**RULE, "name": "Autre", "criticality": "LOW", "sqlQuery": SQL + " -- relais"})
    assert len(client.get("/rules").json()) == 2
    assert [r["name"] for r in client.get("/rules", params={"criticality": "LOW"}).json()] == ["Autre"]
    assert [r["name"] for r in client.get("/rules", params={"q": "RELAIS"}).json()] == ["Autre"]
    assert client.get("/rules", params={"status": "IN_PRODUCTION"}).json() == []


def _submit(client, rule=RULE, rule_id=None):
    did = client.post("/drafts", json={**rule, "ruleId": rule_id}).json()["id"]
    client.post("/query/execute", json={"sql": rule["sqlQuery"], "draftId": did})
    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 200, r.text
    return r.json()["ruleId"]


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
    _submit(client, {**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"}, rid)
    d = client.get(f"/rules/{rid}").json()
    assert (d["status"], d["productionVersion"]) == ("SUBMITTED", 1)
    # Même ligne dans rules_registry, mise à jour : Airflow lira la v2 au prochain run.
    assert bq.registry == {rid: (2, "SUBMITTED")}

    # La v2 démarre : la v1 est remplacée.
    bq.stats.append(RunStats(rid, 2, now, now, "fraud_rule_v2"))
    client.post("/internal/sync-runs")
    d = client.get(f"/rules/{rid}").json()
    assert [v["status"] for v in d["versions"]] == ["IN_PRODUCTION", "REPLACED"]
    # rules_registry : une seule ligne pour la règle, mise à jour avec la v2.
    assert bq.registry == {rid: (2, "IN_PRODUCTION")}


def test_version_qui_a_tourne_reste_figee(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    assert client.get(f"/rules/{rid}").json()["canWithdraw"] is False
    d = client.post("/drafts", json={**RULE, "description": "seuil revu", "ruleId": rid}).json()
    assert (d["withdrawn"], d["baseVersion"]) == (False, 1)
    assert client.get(f"/rules/{rid}").json()["status"] == "IN_PRODUCTION"


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


def test_reprise_d_une_v2_remet_la_v1_dans_rules_registry(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    _submit(client, {**RULE, "description": "v2"}, rid)
    assert bq.registry == {rid: (2, "SUBMITTED")}
    # La v2 n'a jamais tourné : son auteur la reprend, la ligne revient à la v1 qui tourne toujours.
    client.post("/drafts", json={**RULE, "description": "v2 corrigée", "ruleId": rid})
    assert bq.registry == {rid: (1, "IN_PRODUCTION")}
