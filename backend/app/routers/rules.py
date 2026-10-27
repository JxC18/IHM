"""F1, F4, F5 — référentiel, soumission, versions."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import User
from app.schemas import NameAvailable, RuleDetail, RuleInput, RuleStatus, RuleSummary
from app.services import rules as svc
from app.services.bigquery import BigQueryGateway, get_bigquery
from app.services.registry import Registry, get_registry

router = APIRouter(prefix="/rules", tags=["règles"])


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
):
    return svc.list_rules(db, q, status or "", typology, owner, criticality, sort)


# Déclarée avant /{rule_id} pour ne pas être capturée par celle-ci.
@router.get("/name-available", response_model=NameAvailable)
def name_available(
    name: str, exclude: str | None = None, _: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return NameAvailable(available=svc.name_available(db, name, exclude))


@router.get("/{rule_id}", response_model=RuleDetail)
def get_rule(rule_id: str, _: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return svc.detail(db, svc.get_rule(db, rule_id))


@router.post("", response_model=RuleDetail, status_code=201)
def create_rule(
    body: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    registry: Registry = Depends(get_registry),
):
    return svc.create_rule(db, bq, registry, user, body)


@router.put("/{rule_id}", response_model=RuleDetail)
def update_rule(
    rule_id: str,
    body: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    registry: Registry = Depends(get_registry),
):
    return svc.update_rule(db, bq, registry, user, rule_id, body)


@router.post("/{rule_id}/submit", response_model=RuleDetail)
def submit_rule(
    rule_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    registry: Registry = Depends(get_registry),
):
    return svc.submit_rule(db, registry, user, rule_id)
