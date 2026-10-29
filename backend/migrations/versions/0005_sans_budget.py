"""Suppression du budget de scan : le coût estimé des tests n'est plus conservé.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-29
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rule_tests") as batch:
        batch.drop_column("estimated_cost_eur")


def downgrade() -> None:
    with op.batch_alter_table("rule_tests") as batch:
        batch.add_column(sa.Column("estimated_cost_eur", sa.Float))
