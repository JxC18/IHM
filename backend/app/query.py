"""Test d'une requête (PRD F3) : dry-run puis exécution échantillonnée sous garde-fous."""

import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, BytesLimitExceeded, QueryError, get_bigquery
from app.core import ApiError, Settings, get_settings, now
from app.database import Rule, TestRun, User, get_db, record_audit
from app.schemas import BudgetUsage, DryRunResult, ExecutionResult, Guardrails, QueryIn, SqlIssue
from app.sql_checks import check_hardcoded_dates, check_params, query_hash

router = APIRouter(tags=["test"])


def _test_run_date() -> date:
    """Valeur de @run_date pendant un test : la veille, dernière journée complète."""
    return date.today() - timedelta(days=1)


def _month_start(t: datetime) -> datetime:
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _budget(db: Session, settings: Settings, user: User) -> BudgetUsage:
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
    record_audit(db, user, "RULE_TEST", rule.versions[-1] if rule else None, f"{phase} {outcome}")
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


# --------------------------------------------------------------------------- routes


@router.get("/config/guardrails", response_model=Guardrails)
def guardrails(_: User = Depends(get_current_user), s: Settings = Depends(get_settings)) -> Guardrails:
    return Guardrails(
        max_bytes_billed=s.max_bytes_billed,
        job_timeout_ms=s.job_timeout_ms,
        max_results=s.max_results,
        monthly_budget_bytes=s.monthly_budget_bytes,
        cost_per_tb_eur=s.cost_per_tb_eur,
    )


@router.get("/me/budget", response_model=BudgetUsage)
def budget(
    user: User = Depends(get_current_user), db: Session = Depends(get_db), s: Settings = Depends(get_settings)
) -> BudgetUsage:
    return _budget(db, s, user)


@router.post("/query/dry-run", response_model=DryRunResult)
def dry_run(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    settings: Settings = Depends(get_settings),
) -> DryRunResult:
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


@router.post("/query/execute", response_model=ExecutionResult)
def execute(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    settings: Settings = Depends(get_settings),
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
    usage = _budget(db, settings, user)
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
