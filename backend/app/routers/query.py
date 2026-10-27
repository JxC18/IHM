"""F3 — test d'une requête."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import Settings, get_settings
from app.db import get_db
from app.models import User
from app.schemas import DryRunResult, ExecutionResult, Guardrails, QueryIn
from app.services import query as svc
from app.services.bigquery import BigQueryGateway, get_bigquery

router = APIRouter(tags=["test"])


@router.get("/config/guardrails", response_model=Guardrails)
def guardrails(_: User = Depends(get_current_user), s: Settings = Depends(get_settings)):
    return Guardrails(
        max_bytes_billed=s.max_bytes_billed,
        job_timeout_ms=s.job_timeout_ms,
        max_results=s.max_results,
        monthly_budget_bytes=s.monthly_budget_bytes,
        cost_per_tb_eur=s.cost_per_tb_eur,
    )


@router.post("/query/dry-run", response_model=DryRunResult)
def dry_run(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    s: Settings = Depends(get_settings),
):
    return svc.dry_run(db, bq, s, user, body)


@router.post("/query/execute", response_model=ExecutionResult)
def execute(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    s: Settings = Depends(get_settings),
):
    return svc.execute(db, bq, s, user, body)
