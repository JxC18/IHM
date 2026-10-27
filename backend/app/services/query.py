"""Test d'une requête (PRD F3) : dry-run puis exécution échantillonnée sous garde-fous."""

import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.clock import now
from app.config import Settings
from app.errors import ApiError
from app.models import Rule, TestRun, User
from app.schemas import BudgetUsage, DryRunResult, ExecutionResult, QueryIn, SqlIssue
from app.services import audit
from app.services.bigquery import BigQueryGateway, BytesLimitExceeded, QueryError
from app.services.sql_checks import check_hardcoded_dates, check_params, query_hash


def _test_run_date() -> date:
    """Valeur de @run_date pendant un test : la veille, dernière journée complète."""
    return date.today() - timedelta(days=1)


def _month_start(t: datetime) -> datetime:
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def budget(db: Session, settings: Settings, user: User) -> BudgetUsage:
    t = now()
    used = db.scalar(
        select(func.coalesce(func.sum(TestRun.bytes_processed), 0)).where(
            TestRun.by_matricule == user.matricule,
            TestRun.phase == "EXECUTION",
            TestRun.at >= _month_start(t),
        )
    )
    return BudgetUsage(
        month=t.strftime("%Y-%m"), bytes_used=int(used or 0), budget_bytes=settings.monthly_budget_bytes
    )


def _record(db: Session, user: User, body: QueryIn, **fields) -> TestRun:
    rule = db.get(Rule, body.rule_id) if body.rule_id else None
    if body.rule_id and rule is None:
        raise ApiError(404, "Règle introuvable.")
    run = TestRun(
        id=str(uuid.uuid4()),
        rule_id=rule.rule_id if rule else None,
        version=rule.versions[-1].version if rule else None,
        query_hash=query_hash(body.sql, body.parameters),
        at=now(),
        by_matricule=user.matricule,
        **fields,
    )
    db.add(run)
    phase = "Exécution échantillonnée" if fields["phase"] == "EXECUTION" else "Dry-run"
    outcome = "réussi" if fields["success"] else f"en échec : {fields.get('error') or ''}"
    audit.record(db, user, "RULE_TEST", rule.versions[-1] if rule else None, f"{phase} {outcome}")
    db.commit()
    return run


def _analyse(bq: BigQueryGateway, body: QueryIn) -> tuple[list[SqlIssue], object | None]:
    issues = check_params(body.sql, body.parameters) + check_hardcoded_dates(body.sql)
    try:
        meta = bq.dry_run(body.sql, body.parameters, _test_run_date())
    except QueryError as e:
        issues.insert(
            0, SqlIssue(severity="error", code="BIGQUERY", message=e.message, line=e.line, column=e.column)
        )
        return issues, None
    # Contraintes vérifiées sur les métadonnées du dry-run, pas sur le texte (PRD F2).
    if meta.statement_type != "SELECT":
        issues.insert(
            0,
            SqlIssue(
                severity="error",
                code="NOT_SELECT",
                message=f"statementType = {meta.statement_type} : seule une instruction SELECT est autorisée.",  # noqa: E501
            ),
        )
    elif not any(c.name == "order_id" for c in meta.schema):
        issues.append(
            SqlIssue(
                severity="error",
                code="NO_ORDER_ID",
                message="La projection doit exposer la colonne order_id.",
            )
        )
    return issues, meta


def dry_run(db: Session, bq: BigQueryGateway, settings: Settings, user: User, body: QueryIn) -> DryRunResult:
    issues, meta = _analyse(bq, body)
    ok = meta is not None and not any(i.severity == "error" for i in issues)
    cost = (meta.bytes_processed / 1e12) * settings.cost_per_tb_eur if meta else None
    first_error = next((i.message for i in issues if i.severity == "error"), None)
    run = _record(
        db,
        user,
        body,
        phase="DRY_RUN",
        success=ok,
        bytes_processed=meta.bytes_processed if meta else None,
        estimated_cost_eur=cost,
        error=first_error,
    )
    return DryRunResult(
        ok=ok,
        statement_type=meta.statement_type if meta else None,
        output_schema=meta.schema if meta else None,
        bytes_processed=meta.bytes_processed if meta else None,
        estimated_cost_eur=cost,
        issues=issues,
        exceeds_bytes_limit=bool(meta and meta.bytes_processed > settings.max_bytes_billed),
        test_id=run.id,
    )


def execute(
    db: Session, bq: BigQueryGateway, settings: Settings, user: User, body: QueryIn
) -> ExecutionResult:
    issues, meta = _analyse(bq, body)
    if meta is None or any(i.severity == "error" for i in issues):
        raise ApiError(422, "Le dry-run doit réussir avant toute exécution.")
    if meta.bytes_processed > settings.max_bytes_billed:
        raise ApiError(
            422,
            f"Exécution refusée : volume estimé {meta.bytes_processed / 1e9:.1f} Go, "
            f"plafond {settings.max_bytes_billed / 1e9:.0f} Go (maximumBytesBilled).",
            "BYTES_LIMIT",
        )
    usage = budget(db, settings, user)
    if usage.bytes_used + meta.bytes_processed > usage.budget_bytes:
        raise ApiError(
            429, "Budget mensuel de scan atteint : exécution bloquée jusqu'au mois prochain.", "BUDGET"
        )
    try:
        res = bq.execute(body.sql, body.parameters, _test_run_date())
    except BytesLimitExceeded as e:
        _record(db, user, body, phase="EXECUTION", success=False, error=str(e))
        raise ApiError(422, "Exécution interrompue : plafond de volume scanné atteint.", "BYTES_LIMIT") from e
    except QueryError as e:
        _record(db, user, body, phase="EXECUTION", success=False, error=e.message)
        raise ApiError(422, e.message, "BIGQUERY") from e
    # Seules les métadonnées sont persistées ; les lignes ne quittent pas la réponse (PRD §10).
    run = _record(
        db,
        user,
        body,
        phase="EXECUTION",
        success=True,
        bytes_processed=res.bytes_processed,
        duration_ms=res.duration_ms,
        total_rows=res.total_rows,
    )
    return ExecutionResult(
        ok=True,
        columns=res.columns,
        rows=res.rows,
        total_rows=res.total_rows,
        duration_ms=res.duration_ms,
        bytes_processed=res.bytes_processed,
        test_id=run.id,
    )
