"""Schéma initial : utilisateurs, sessions, règles, versions, tests, audit.

Revision ID: 0001
Revises:
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("matricule", sa.String(6), primary_key=True),
        sa.Column("first_name", sa.String(100), nullable=False),
        sa.Column("last_name", sa.String(100), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("matricule", sa.String(6), nullable=False, index=True),
        sa.Column("pending_profile", sa.Boolean, nullable=False),
        sa.Column("last_seen", TS, nullable=False),
    )
    op.create_table(
        "rules",
        sa.Column("rule_id", sa.String(36), primary_key=True),
        sa.Column("owner_matricule", sa.String(6), sa.ForeignKey("users.matricule"), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("name_key", sa.String(200), nullable=False, unique=True),
    )
    op.create_table(
        "rule_versions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("rule_id", sa.String(36), sa.ForeignKey("rules.rule_id"), nullable=False, index=True),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("fraud_typology", sa.String(100), nullable=False),
        sa.Column("criticality", sa.String(10), nullable=False),
        sa.Column("schedule", sa.String(10), nullable=False),
        sa.Column("sql_query", sa.Text, nullable=False),
        sa.Column("parameters", sa.JSON, nullable=False),
        sa.Column("status", sa.String(20), nullable=False, index=True),
        sa.Column("rejection_reason", sa.Text),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.Column("submitted_at", TS),
        sa.Column("airflow_dag_id", sa.String(200)),
        sa.UniqueConstraint("rule_id", "version"),
    )
    op.create_table(
        "rule_tests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("rule_id", sa.String(36), index=True),
        sa.Column("version", sa.Integer),
        sa.Column("query_hash", sa.String(16), nullable=False),
        sa.Column("at", TS, nullable=False, index=True),
        sa.Column("by_matricule", sa.String(6), nullable=False, index=True),
        sa.Column("phase", sa.String(10), nullable=False),
        sa.Column("success", sa.Boolean, nullable=False),
        sa.Column("bytes_processed", sa.BigInteger),
        sa.Column("estimated_cost_eur", sa.Float),
        sa.Column("duration_ms", sa.Integer),
        sa.Column("total_rows", sa.BigInteger),
        sa.Column("error", sa.Text),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("at", TS, nullable=False, index=True),
        sa.Column("matricule", sa.String(6), nullable=False, index=True),
        sa.Column("user_name", sa.String(200), nullable=False),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("rule_id", sa.String(36), index=True),
        sa.Column("rule_name", sa.String(200)),
        sa.Column("version", sa.Integer),
        sa.Column("details", sa.Text),
    )
    # Journal immuable : le rôle applicatif n'a que INSERT/SELECT (à appliquer par le DBA) :
    #   REVOKE UPDATE, DELETE ON audit_events FROM rules_app;


def downgrade() -> None:
    for t in ("audit_events", "rule_tests", "rule_versions", "rules", "sessions", "users"):
        op.drop_table(t)
