"""Base applicative (Cloud SQL / PostgreSQL, PRD §8.3) : connexion, tables, journal d'audit.

Le matricule est la clé d'identité partout (PRD §5.4, règle 1) : passer au SSO
changera la source du matricule, pas ces tables.
"""

import uuid
from collections.abc import Iterator
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from app.core import get_settings, now

# --------------------------------------------------------------------------- connexion


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def init_engine(url: str | None = None, **kwargs):
    global _engine, _SessionLocal
    _engine = create_engine(url or get_settings().database_url, pool_pre_ping=True, **kwargs)
    _SessionLocal = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_db() -> Iterator[Session]:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    with _SessionLocal() as session:
        yield session


# --------------------------------------------------------------------------- tables


class User(Base):
    __tablename__ = "users"

    matricule: Mapped[str] = mapped_column(String(6), primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


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
    # Seuls les gestes de l'analyste sont stockés (DRAFT, SUBMITTED). En production, inactive et
    # remplacée se déduisent des exécutions Airflow (colonnes *_run_at), voir rules.derive_status.
    status: Mapped[str] = mapped_column(String(20), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Recopiés depuis BigQuery `rule_runs` par la synchronisation (rules.sync_runs).
    airflow_dag_id: Mapped[str | None] = mapped_column(String(200))
    first_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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


def record_audit(
    db: Session, user: User, action: str, version: RuleVersion | None = None, details: str | None = None
) -> None:
    """Ajoute un événement au journal (jamais de mise à jour ni de suppression)."""
    db.add(
        AuditEvent(
            id=str(uuid.uuid4()),
            at=now(),
            matricule=user.matricule,
            user_name=user.full_name,
            action=action,
            rule_id=version.rule_id if version else None,
            rule_name=version.name if version else None,
            version=version.version if version else None,
            details=details,
        )
    )
