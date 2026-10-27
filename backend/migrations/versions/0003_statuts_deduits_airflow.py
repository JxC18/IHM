"""Statuts déduits des exécutions Airflow : plus de motif de refus, dates de premier / dernier run.

L'équipe data n'agit pas sur la plateforme : « en production », « inactive » et « remplacée » se
déduisent de `rule_runs` ; seuls DRAFT et SUBMITTED restent stockés.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("rejection_reason")
        batch.add_column(sa.Column("first_run_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("last_run_at", sa.DateTime(timezone=True)))
    # Anciens statuts posés à la main : on ne garde que le geste de l'analyste.
    op.execute("UPDATE rule_versions SET status = 'SUBMITTED' WHERE status NOT IN ('DRAFT', 'SUBMITTED')")


def downgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("last_run_at")
        batch.drop_column("first_run_at")
        batch.add_column(sa.Column("rejection_reason", sa.Text))
