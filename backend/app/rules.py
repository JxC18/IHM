"""Règles : référentiel, versions, soumission à l'équipe data (PRD F1, F4, F5)."""

import json
import logging
import re
import unicodedata
import urllib.request
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, QueryError, get_bigquery
from app.core import ApiError, as_utc, get_settings, now
from app.database import Rule, RuleVersion, TestRun, User, get_db, record_audit
from app.schemas import (
    NameAvailable,
    RuleDetail,
    RuleInput,
    RuleStatus,
    RuleSummary,
    RuleVersionOut,
    TestRecord,
)
from app.sql_checks import query_hash

log = logging.getLogger(__name__)
router = APIRouter(prefix="/rules", tags=["règles"])

REQUIRED = {
    "name": "Nom",
    "description": "Description métier",
    "fraud_typology": "Typologie de fraude",
    "sql_query": "Requête SQL",
}
# Fenêtre pendant laquelle un test fait depuis l'éditeur est rattaché à la version enregistrée ensuite.
TEST_ADOPTION_WINDOW = timedelta(hours=1)


def name_key(name: str) -> str:
    s = unicodedata.normalize("NFD", name.strip())
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def _users(db: Session) -> dict[str, User]:
    return {u.matricule: u for u in db.scalars(select(User))}


def _test_out(t: TestRun, users: dict[str, User]) -> TestRecord:
    u = users.get(t.by_matricule)
    fields = {k: getattr(t, k) for k in TestRecord.model_fields if k != "by_name"}
    return TestRecord(**fields, by_name=u.full_name if u else t.by_matricule)


# Une version est « inactive » après 3 périodes sans exécution (3 jours pour une règle quotidienne…).
INACTIVE_AFTER_PERIODS = 3
SCHEDULE_PERIOD = {"HOURLY": timedelta(hours=1), "DAILY": timedelta(days=1), "WEEKLY": timedelta(weeks=1)}


def derive_status(rule: Rule, v: RuleVersion, at: datetime | None = None) -> str:
    """Statut affiché d'une version.

    L'équipe data n'agit pas sur la plateforme : la mise en production se constate dans les
    exécutions Airflow (`rule_runs`), recopiées dans first_run_at / last_run_at.
    """
    if v.status == "DRAFT":
        return "DRAFT"
    newer = [w for w in rule.versions if w.version > v.version]
    if any(w.first_run_at for w in newer):
        return "REPLACED"  # une version plus récente tourne à sa place
    if v.first_run_at and v.last_run_at:
        idle = (at or now()) - as_utc(v.last_run_at)
        limit = SCHEDULE_PERIOD.get(v.schedule, timedelta(days=1)) * INACTIVE_AFTER_PERIODS
        return "INACTIVE" if idle > limit else "IN_PRODUCTION"
    if any(w.status == "SUBMITTED" for w in newer):
        return "REPLACED"  # une version plus récente a été soumise avant que celle-ci ne tourne
    return "SUBMITTED"


def running_version(rule: Rule) -> RuleVersion | None:
    """Version orchestrée par Airflow (en production ou inactive), s'il y en a une."""
    return next((v for v in rule.versions if derive_status(rule, v) in ("IN_PRODUCTION", "INACTIVE")), None)


def _version_out(v: RuleVersion, rule: Rule, users: dict[str, User]) -> RuleVersionOut:
    owner = users.get(rule.owner_matricule)
    return RuleVersionOut(
        rule_id=v.rule_id,
        version=v.version,
        name=v.name,
        description=v.description,
        fraud_typology=v.fraud_typology,
        criticality=v.criticality,  # type: ignore[arg-type]
        schedule=v.schedule,  # type: ignore[arg-type]
        sql_query=v.sql_query,
        status=derive_status(rule, v),  # type: ignore[arg-type]
        owner_matricule=rule.owner_matricule,
        owner_name=owner.full_name if owner else rule.owner_matricule,
        created_at=v.created_at,
        updated_at=v.updated_at,
        submitted_at=v.submitted_at,
        airflow_dag_id=v.airflow_dag_id,
        first_run_at=v.first_run_at,
        last_run_at=v.last_run_at,
    )


def _last_test(db: Session, rule_id: str, version: int) -> TestRun | None:
    return db.scalars(
        select(TestRun)
        .where(TestRun.rule_id == rule_id, TestRun.version == version)
        .order_by(TestRun.at.desc())
        .limit(1)
    ).first()


def summary(db: Session, rule: Rule, users: dict[str, User] | None = None) -> RuleSummary:
    users = users if users is not None else _users(db)
    cur = rule.versions[-1]
    prod = running_version(rule)
    last = _last_test(db, rule.rule_id, cur.version)
    return RuleSummary(
        **_version_out(cur, rule, users).model_dump(),
        version_count=len(rule.versions),
        production_version=prod.version if prod and prod.version != cur.version else None,
        last_test=_test_out(last, users) if last else None,
    )


def detail(db: Session, rule: Rule) -> RuleDetail:
    users = _users(db)
    tests = db.scalars(select(TestRun).where(TestRun.rule_id == rule.rule_id).order_by(TestRun.at.desc()))
    return RuleDetail(
        **summary(db, rule, users).model_dump(),
        versions=[_version_out(v, rule, users) for v in reversed(rule.versions)],
        tests=[_test_out(t, users) for t in tests],
    )


def load_rule(db: Session, rule_id: str) -> Rule:
    rule = db.scalars(
        select(Rule).where(Rule.rule_id == rule_id).options(selectinload(Rule.versions))
    ).first()
    if rule is None:
        raise ApiError(404, "Règle introuvable.")
    return rule


def _name_free(db: Session, name: str, exclude_rule_id: str | None = None) -> bool:
    existing = db.scalars(select(Rule).where(Rule.name_key == name_key(name))).first()
    return existing is None or existing.rule_id == exclude_rule_id


def _first_keyword(sql: str) -> str:
    m = re.match(r"\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(\w+)", sql, re.S)
    return m.group(1).upper() if m else ""


def _validate(db: Session, bq: BigQueryGateway, data: RuleInput, exclude_rule_id: str | None = None) -> None:
    missing = [label for f, label in REQUIRED.items() if not str(getattr(data, f)).strip()]
    if missing:
        raise ApiError(422, f"Champs obligatoires manquants : {', '.join(missing)}.")
    if not _name_free(db, data.name, exclude_rule_id):
        raise ApiError(409, f"Une règle nommée « {data.name.strip()} » existe déjà.", "NAME_TAKEN")
    # DML/DDL rejetés dès l'enregistrement, d'après le dry-run quand il aboutit (PRD F2).
    # Les autres contraintes (order_id, @run_date…) bloquent la soumission, pas le brouillon.
    try:
        stype = bq.dry_run(data.sql_query, date.today()).statement_type
    except QueryError:
        kw = _first_keyword(data.sql_query)
        stype = "SELECT" if kw in ("SELECT", "WITH") else kw
    if stype != "SELECT":
        raise ApiError(
            422, f"Instruction {stype} refusée : seule une instruction SELECT est autorisée.", "NOT_SELECT"
        )


def _apply(v: RuleVersion, data: RuleInput) -> None:
    v.name = data.name.strip()
    v.description = data.description
    v.fraud_typology = data.fraud_typology
    v.criticality = data.criticality
    v.schedule = data.schedule
    v.sql_query = data.sql_query


def _adopt_tests(
    db: Session, user: User, v: RuleVersion, from_rule: str | None, from_version: int | None
) -> None:
    """Rattache à `v` les tests récents de l'utilisateur portant exactement sur son contenu."""
    h = query_hash(v.sql_query)
    since = now() - TEST_ADOPTION_WINDOW
    for t in db.scalars(
        select(TestRun).where(
            TestRun.by_matricule == user.matricule,
            TestRun.query_hash == h,
            TestRun.rule_id.is_(None) if from_rule is None else TestRun.rule_id == from_rule,
        )
    ):
        if as_utc(t.at) >= since and (from_rule is None or t.version == from_version):
            t.rule_id, t.version = v.rule_id, v.version


def _commit_name(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError as e:  # course entre deux créations : l'unicité est garantie par la base
        db.rollback()
        raise ApiError(409, f"Une règle nommée « {name.strip()} » existe déjà.", "NAME_TAKEN") from e


def _publish(bq: BigQueryGateway, rule: Rule, *versions: RuleVersion) -> None:
    for v in versions:
        bq.publish_rule(v, rule.owner_matricule, derive_status(rule, v))


def sync_runs(db: Session, bq: BigQueryGateway) -> int:
    """Recopie depuis `rule_runs` les dates de premier / dernier run et le DAG de chaque version.

    Appelée périodiquement (Cloud Scheduler). Renvoie le nombre de règles mises à jour.
    """
    stats = {(s.rule_id, s.rule_version): s for s in bq.run_stats()}
    touched: dict[str, Rule] = {}
    for v in db.scalars(select(RuleVersion)):
        s = stats.get((v.rule_id, v.version))
        if not s:
            continue
        known = (
            v.first_run_at and as_utc(v.first_run_at),
            v.last_run_at and as_utc(v.last_run_at),
            v.airflow_dag_id,
        )
        if known != (as_utc(s.first_run_at), as_utc(s.last_run_at), s.dag_id):
            v.first_run_at, v.last_run_at, v.airflow_dag_id = s.first_run_at, s.last_run_at, s.dag_id
            touched[v.rule_id] = v.rule
    db.commit()
    # Une version qui démarre peut en remplacer une autre : on republie toute la règle.
    for rule in touched.values():
        _publish(bq, rule, *rule.versions)
    return len(touched)


def notify_data_team(event: str, v: RuleVersion, by: str) -> None:
    """Prévient l'équipe data : RULE_SUBMITTED, ou RULE_SUBMISSION_WITHDRAWN quand l'analyste
    reprend une version soumise pour la modifier."""
    payload = {"event": event, "ruleId": v.rule_id, "version": v.version, "name": v.name, "by": by}
    url = get_settings().notify_webhook_url
    if not url:
        log.info("notification équipe data (pas de canal configuré) : %s", payload)
        return
    try:
        req = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).close()
    except OSError:
        # La soumission est enregistrée ; un échec de notification ne doit pas l'annuler.
        log.exception("échec de la notification équipe data")


# --------------------------------------------------------------------------- routes


@router.get("", response_model=list[RuleSummary])
def list_rules(
    q: str = "",
    status: RuleStatus | None = None,
    typology: str = "",
    owner: str = "",
    criticality: str = "",
    sort: str = "updated_desc",
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[RuleSummary]:
    # Volumétrie de l'ordre de la centaine (PRD H1) : filtrage en mémoire sur la version courante.
    users = _users(db)
    rules = db.scalars(select(Rule).options(selectinload(Rule.versions))).all()
    needle = name_key(q) if q else ""
    out = []
    for r in rules:
        cur = r.versions[-1]
        if needle and needle not in name_key(f"{cur.name}\n{cur.description}\n{cur.sql_query}"):
            continue
        if typology and cur.fraud_typology != typology:
            continue
        if (owner and r.owner_matricule != owner) or (criticality and cur.criticality != criticality):
            continue
        s = summary(db, r, users)
        if status and s.status != status:
            continue
        out.append(s)
    out.sort(key=lambda s: s.updated_at, reverse=sort != "updated_asc")
    return out


# Déclarée avant /{rule_id} pour ne pas être capturée par celle-ci.
@router.get("/name-available", response_model=NameAvailable)
def name_available(
    name: str, exclude: str | None = None, _: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> NameAvailable:
    return NameAvailable(available=_name_free(db, name, exclude))


@router.get("/{rule_id}", response_model=RuleDetail)
def get_rule(rule_id: str, _: User = Depends(get_current_user), db: Session = Depends(get_db)) -> RuleDetail:
    return detail(db, load_rule(db, rule_id))


@router.post("", response_model=RuleDetail, status_code=201)
def create_rule(
    data: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> RuleDetail:
    _validate(db, bq, data)
    t = now()
    rule = Rule(
        rule_id=str(uuid.uuid4()), owner_matricule=user.matricule, created_at=t, name_key=name_key(data.name)
    )
    v = RuleVersion(rule_id=rule.rule_id, version=1, status="DRAFT", created_at=t, updated_at=t)
    _apply(v, data)
    rule.versions.append(v)
    db.add(rule)
    db.flush()
    _adopt_tests(db, user, v, None, None)
    record_audit(db, user, "RULE_CREATE", v)
    _commit_name(db, data.name)
    _publish(bq, rule, v)
    return detail(db, rule)


@router.put("/{rule_id}", response_model=RuleDetail)
def update_rule(
    rule_id: str,
    data: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> RuleDetail:
    rule = load_rule(db, rule_id)
    _validate(db, bq, data, rule_id)
    cur = rule.versions[-1]
    t = now()
    rule.name_key = name_key(data.name)
    withdrawn = cur.status == "SUBMITTED" and cur.first_run_at is None
    if cur.status == "DRAFT" or withdrawn:
        # Brouillon, ou version soumise qu'Airflow n'a jamais exécutée : modification sur place.
        # Une version soumise repasse en brouillon (même numéro) et devra être retestée et resoumise.
        _apply(cur, data)
        cur.updated_at = t
        target = cur
        if withdrawn:
            cur.status, cur.submitted_at = "DRAFT", None
        record_audit(
            db, user, "RULE_UPDATE", cur, "Soumission retirée pour modification" if withdrawn else None
        )
    else:
        # Une version qui a tourné dans Airflow est figée : nouvelle version en brouillon.
        target = RuleVersion(
            rule_id=rule_id, version=cur.version + 1, status="DRAFT", created_at=t, updated_at=t
        )
        _apply(target, data)
        rule.versions.append(target)
        db.flush()
        _adopt_tests(db, user, target, rule_id, cur.version)
        record_audit(
            db,
            user,
            "RULE_NEW_VERSION",
            target,
            f"Nouvelle version créée à partir de la v{cur.version} ({cur.status})",
        )
    _commit_name(db, data.name)
    _publish(bq, rule, target)
    if withdrawn:
        notify_data_team("RULE_SUBMISSION_WITHDRAWN", target, user.matricule)
    return detail(db, rule)


@router.post("/{rule_id}/submit", response_model=RuleDetail)
def submit_rule(
    rule_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> RuleDetail:
    rule = load_rule(db, rule_id)
    cur = rule.versions[-1]
    if cur.status != "DRAFT":
        raise ApiError(409, "Seule une version en brouillon peut être soumise.")
    last = _last_test(db, rule_id, cur.version)
    h = query_hash(cur.sql_query)
    if not last or not last.success or last.phase != "EXECUTION" or last.query_hash != h:
        raise ApiError(
            409,
            "Le dernier test doit être une exécution réussie portant sur la version courante de la requête.",
            "TEST_REQUIRED",
        )
    cur.status = "SUBMITTED"
    cur.submitted_at = cur.updated_at = now()
    record_audit(db, user, "RULE_SUBMIT", cur, "Notification envoyée à l'équipe data")
    db.commit()
    # Les versions précédentes peuvent passer « Remplacée » : on les republie aussi.
    _publish(bq, rule, *rule.versions)
    notify_data_team("RULE_SUBMITTED", cur, user.matricule)
    return detail(db, rule)
