"""Référentiel et cycle de vie des règles (PRD F1, F4, F5)."""

import re
import unicodedata
import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.auth import full_name
from app.clock import as_utc, now
from app.errors import ApiError
from app.models import Rule, RuleVersion, TestRun, User
from app.schemas import RuleDetail, RuleInput, RuleParameter, RuleSummary, RuleVersionOut, TestRecord
from app.services import audit
from app.services.bigquery import BigQueryGateway, QueryError
from app.services.notifier import notify_submission
from app.services.registry import Registry
from app.services.sql_checks import query_hash

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
    return TestRecord(**fields, by_name=full_name(u) if u else t.by_matricule)


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
        parameters=[RuleParameter.model_validate(p) for p in v.parameters],
        status=v.status,  # type: ignore[arg-type]
        rejection_reason=v.rejection_reason,
        owner_matricule=rule.owner_matricule,
        owner_name=full_name(owner) if owner else rule.owner_matricule,
        created_at=v.created_at,
        updated_at=v.updated_at,
        submitted_at=v.submitted_at,
        airflow_dag_id=v.airflow_dag_id,
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
    prod = next((v for v in rule.versions if v.status == "IN_PRODUCTION"), None)
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


def get_rule(db: Session, rule_id: str) -> Rule:
    rule = db.scalars(
        select(Rule).where(Rule.rule_id == rule_id).options(selectinload(Rule.versions))
    ).first()
    if rule is None:
        raise ApiError(404, "Règle introuvable.")
    return rule


def list_rules(
    db: Session,
    q: str = "",
    status: str = "",
    typology: str = "",
    owner: str = "",
    criticality: str = "",
    sort: str = "updated_desc",
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
        if (status and cur.status != status) or (typology and cur.fraud_typology != typology):
            continue
        if (owner and r.owner_matricule != owner) or (criticality and cur.criticality != criticality):
            continue
        out.append(summary(db, r, users))
    out.sort(key=lambda s: s.updated_at, reverse=sort != "updated_asc")
    return out


def name_available(db: Session, name: str, exclude_rule_id: str | None = None) -> bool:
    existing = db.scalars(select(Rule).where(Rule.name_key == name_key(name))).first()
    return existing is None or existing.rule_id == exclude_rule_id


def _first_keyword(sql: str) -> str:
    m = re.match(r"\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(\w+)", sql, re.S)
    return m.group(1).upper() if m else ""


def validate_input(
    db: Session, bq: BigQueryGateway, data: RuleInput, exclude_rule_id: str | None = None
) -> None:
    missing = [label for f, label in REQUIRED.items() if not str(getattr(data, f)).strip()]
    if missing:
        raise ApiError(422, f"Champs obligatoires manquants : {', '.join(missing)}.")
    if not name_available(db, data.name, exclude_rule_id):
        raise ApiError(409, f"Une règle nommée « {data.name.strip()} » existe déjà.", "NAME_TAKEN")
    # DML/DDL rejetés dès l'enregistrement, d'après le dry-run quand il aboutit (PRD F2).
    # Les autres contraintes (order_id, @run_date…) bloquent la soumission, pas le brouillon.
    try:
        stype = bq.dry_run(data.sql_query, data.parameters, date.today()).statement_type
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
    v.parameters = [p.model_dump() for p in data.parameters]


def _adopt_tests(
    db: Session, user: User, v: RuleVersion, from_rule: str | None, from_version: int | None
) -> None:
    """Rattache à `v` les tests récents de l'utilisateur portant exactement sur son contenu."""
    h = query_hash(v.sql_query, [RuleParameter.model_validate(p) for p in v.parameters])
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


def create_rule(
    db: Session, bq: BigQueryGateway, registry: Registry, user: User, data: RuleInput
) -> RuleDetail:
    validate_input(db, bq, data)
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
    audit.record(db, user, "RULE_CREATE", v)
    _commit_name(db, data.name)
    registry.upsert(v, rule.owner_matricule)
    return detail(db, rule)


def update_rule(
    db: Session, bq: BigQueryGateway, registry: Registry, user: User, rule_id: str, data: RuleInput
) -> RuleDetail:
    rule = get_rule(db, rule_id)
    validate_input(db, bq, data, rule_id)
    cur = rule.versions[-1]
    t = now()
    rule.name_key = name_key(data.name)
    if cur.status == "DRAFT":
        _apply(cur, data)
        cur.updated_at = t
        target = cur
        audit.record(db, user, "RULE_UPDATE", cur)
    else:
        # Une version non-DRAFT n'est plus modifiable : nouvelle version en DRAFT (PRD F5).
        target = RuleVersion(
            rule_id=rule_id, version=cur.version + 1, status="DRAFT", created_at=t, updated_at=t
        )
        _apply(target, data)
        rule.versions.append(target)
        db.flush()
        _adopt_tests(db, user, target, rule_id, cur.version)
        audit.record(
            db,
            user,
            "RULE_NEW_VERSION",
            target,
            f"Nouvelle version créée à partir de la v{cur.version} ({cur.status})",
        )
    _commit_name(db, data.name)
    registry.upsert(target, rule.owner_matricule)
    return detail(db, rule)


def submit_rule(db: Session, registry: Registry, user: User, rule_id: str) -> RuleDetail:
    rule = get_rule(db, rule_id)
    cur = rule.versions[-1]
    if cur.status != "DRAFT":
        raise ApiError(409, "Seule une version en brouillon peut être soumise.")
    last = _last_test(db, rule_id, cur.version)
    h = query_hash(cur.sql_query, [RuleParameter.model_validate(p) for p in cur.parameters])
    if not last or not last.success or last.phase != "EXECUTION" or last.query_hash != h:
        raise ApiError(
            409,
            "Le dernier test doit être une exécution réussie portant sur la version courante de la requête.",
            "TEST_REQUIRED",
        )
    cur.status = "SUBMITTED"
    cur.submitted_at = cur.updated_at = now()
    audit.record(db, user, "RULE_SUBMIT", cur, "Notification envoyée à l'équipe data")
    db.commit()
    registry.upsert(cur, rule.owner_matricule)
    notify_submission(cur, user.matricule)
    return detail(db, rule)
