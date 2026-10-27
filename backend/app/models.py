"""État applicatif (Cloud SQL / PostgreSQL, PRD §8.3).

Le matricule est la clé d'identité partout (PRD §5.4, règle 1) : passer au SSO
changera la source du matricule, pas ces tables.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class User(Base):
    __tablename__ = "users"

    matricule: Mapped[str] = mapped_column(String(6), primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UserSession(Base):
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    matricule: Mapped[str] = mapped_column(String(6), index=True)
    # Vrai tant que nom et prénom n'ont pas été saisis (première connexion).
    pending_profile: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Rule(Base):
    __tablename__ = "rules"

    rule_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_matricule: Mapped[str] = mapped_column(String(6), ForeignKey("users.matricule"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Nom de la version courante, normalisé, pour l'unicité (F1).
    name_key: Mapped[str] = mapped_column(String(200), unique=True)

    versions: Mapped[list["RuleVersion"]] = relationship(
        back_populates="rule", order_by="RuleVersion.version", cascade="all, delete-orphan"
    )


class RuleVersion(Base):
    __tablename__ = "rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[str] = mapped_column(String(36), ForeignKey("rules.rule_id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    fraud_typology: Mapped[str] = mapped_column(String(100))
    criticality: Mapped[str] = mapped_column(String(10))
    schedule: Mapped[str] = mapped_column(String(10))
    sql_query: Mapped[str] = mapped_column(Text)
    parameters: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), index=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    airflow_dag_id: Mapped[str | None] = mapped_column(String(200))

    rule: Mapped[Rule] = relationship(back_populates="versions")


class TestRun(Base):
    """Métadonnées d'un test (F3). Jamais les lignes retournées (PRD §10)."""

    __tablename__ = "rule_tests"
    __test__ = False  # pas une classe de test pytest

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    rule_id: Mapped[str | None] = mapped_column(String(36), index=True)
    version: Mapped[int | None] = mapped_column(Integer)
    query_hash: Mapped[str] = mapped_column(String(16))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    by_matricule: Mapped[str] = mapped_column(String(6), index=True)
    phase: Mapped[str] = mapped_column(String(10))  # DRY_RUN | EXECUTION
    success: Mapped[bool] = mapped_column(Boolean)
    bytes_processed: Mapped[int | None] = mapped_column(BigInteger)
    estimated_cost_eur: Mapped[float | None] = mapped_column(Float)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    total_rows: Mapped[int | None] = mapped_column(BigInteger)
    error: Mapped[str | None] = mapped_column(Text)


class AuditEvent(Base):
    """Journal d'audit, en ajout seul (immuable, conservation 24 mois)."""

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    matricule: Mapped[str] = mapped_column(String(6), index=True)
    user_name: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(30))
    rule_id: Mapped[str | None] = mapped_column(String(36), index=True)
    rule_name: Mapped[str | None] = mapped_column(String(200))
    version: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[str | None] = mapped_column(Text)
