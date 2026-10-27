"""Suppression des paramètres déclarés : les seuils s'écrivent dans le SQL, seul @run_date reste.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("parameters")


def downgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.add_column(sa.Column("parameters", sa.JSON, nullable=False, server_default="[]"))
