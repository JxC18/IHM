"""F6, F7 — indicateurs, lus dans BigQuery (vue v_rule_performance, table rule_runs)."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import full_name, get_current_user
from app.config import Settings, get_settings
from app.db import get_db
from app.errors import ApiError
from app.models import Rule, User
from app.schemas import ConsolidatedRow, PerformanceResponse
from app.services.bigquery import BigQueryGateway, get_bigquery
from app.services.rules import get_rule

router = APIRouter(tags=["indicateurs"])


@router.get("/rules/{rule_id}/performance", response_model=PerformanceResponse)
def performance(
    rule_id: str,
    from_: date = Query(alias="from"),
    to: date = Query(),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    s: Settings = Depends(get_settings),
):
    if from_ > to:
        raise ApiError(422, "La date de début doit précéder la date de fin.")
    get_rule(db, rule_id)
    length = (to - from_).days + 1
    prev_to = from_ - timedelta(days=1)
    return PerformanceResponse(
        rule_id=rule_id,
        from_=from_,
        to=to,
        daily=bq.daily_performance(rule_id, from_, to),
        previous=bq.daily_performance(rule_id, prev_to - timedelta(days=length - 1), prev_to),
        runs=bq.runs(rule_id, from_, to),
        latency_days=s.latency_days,
    )


@router.get("/performance/production", response_model=list[ConsolidatedRow])
def production(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
):
    rules = db.scalars(select(Rule).options(selectinload(Rule.versions))).all()
    prod = {r.rule_id: (r, v) for r in rules for v in r.versions if v.status == "IN_PRODUCTION"}
    users = {u.matricule: u for u in db.scalars(select(User))}
    end = date.today()
    totals = {t.rule_id: t for t in bq.production_totals(list(prod), end - timedelta(days=29), end)}
    out = []
    for rid, (r, v) in prod.items():
        t = totals.get(rid)
        owner = users.get(r.owner_matricule)
        out.append(
            ConsolidatedRow(
                rule_id=rid,
                name=v.name,
                version=v.version,
                fraud_typology=v.fraud_typology,
                criticality=v.criticality,  # type: ignore[arg-type]
                owner_name=full_name(owner) if owner else r.owner_matricule,
                ordersFlagged30d=t.flagged if t else 0,
                ordersProcessed30d=t.processed if t else 0,
                ordersConfirmed30d=t.confirmed if t else 0,
            )
        )
    return out
