"""Brouillons personnels : table `drafts`, les versions de règle sont toutes soumises.

Un brouillon est la sauvegarde de travail d'un analyste, visible de lui seul. Les versions DRAFT
existantes y sont déplacées ; une règle qui n'avait qu'un brouillon quitte le référentiel.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-28
"""

import uuid

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "drafts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("matricule", sa.String(6), sa.ForeignKey("users.matricule"), nullable=False, index=True),
        sa.Column("rule_id", sa.String(36), nullable=False),
        sa.Column("base_version", sa.Integer),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("fraud_typology", sa.String(100), nullable=False),
        sa.Column("criticality", sa.String(10), nullable=False),
        sa.Column("schedule", sa.String(10), nullable=False),
        sa.Column("sql_query", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("matricule", "rule_id"),
    )
    with op.batch_alter_table("rule_tests") as batch:
        batch.add_column(sa.Column("draft_id", sa.String(36)))
        batch.create_index("ix_rule_tests_draft_id", ["draft_id"])
    with op.batch_alter_table("rule_versions") as batch:
        batch.add_column(sa.Column("submitted_by", sa.String(6)))

    conn = op.get_bind()
    drafts = conn.execute(
        sa.text(
            "SELECT v.id, v.rule_id, v.version, v.name, v.description, v.fraud_typology, v.criticality,"
            " v.schedule, v.sql_query, v.created_at, v.updated_at, r.owner_matricule"
            " FROM rule_versions v JOIN rules r ON r.rule_id = v.rule_id WHERE v.status = 'DRAFT'"
        )
    ).mappings()
    for v in list(drafts):
        draft_id = str(uuid.uuid4())
        conn.execute(
            sa.text(
                "INSERT INTO drafts (id, matricule, rule_id, base_version, name, description, fraud_typology,"
                " criticality, schedule, sql_query, created_at, updated_at) VALUES (:id, :m, :rule_id, :base,"
                " :name, :description, :fraud_typology, :criticality, :schedule, :sql_query, :created_at,"
                " :updated_at)"
            ),
            {
                **v,
                "id": draft_id,
                "m": v["owner_matricule"],
                "base": v["version"] - 1 if v["version"] > 1 else None,
            },
        )
        conn.execute(
            sa.text(
                "UPDATE rule_tests SET draft_id = :d, rule_id = NULL, version = NULL"
                " WHERE rule_id = :rule_id AND version = :version"
            ),
            {"d": draft_id, "rule_id": v["rule_id"], "version": v["version"]},
        )
        conn.execute(sa.text("DELETE FROM rule_versions WHERE id = :id"), {"id": v["id"]})
    conn.execute(sa.text("DELETE FROM rules WHERE rule_id NOT IN (SELECT rule_id FROM rule_versions)"))
    conn.execute(
        sa.text(
            "UPDATE rule_versions SET submitted_by ="
            " (SELECT owner_matricule FROM rules WHERE rules.rule_id = rule_versions.rule_id),"
            " submitted_at = COALESCE(submitted_at, updated_at)"
        )
    )

    with op.batch_alter_table("rule_versions") as batch:
        batch.alter_column("submitted_by", existing_type=sa.String(6), nullable=False)
        batch.alter_column("submitted_at", existing_type=sa.DateTime(timezone=True), nullable=False)
        batch.create_foreign_key("fk_rule_versions_submitted_by", "users", ["submitted_by"], ["matricule"])
        batch.drop_index("ix_rule_versions_status")
        batch.drop_column("status")


def downgrade() -> None:
    # Les brouillons ne peuvent pas redevenir des versions sans perte : ils sont abandonnés.
    with op.batch_alter_table("rule_versions") as batch:
        batch.add_column(sa.Column("status", sa.String(20), nullable=False, server_default="SUBMITTED"))
        batch.create_index("ix_rule_versions_status", ["status"])
        batch.drop_constraint("fk_rule_versions_submitted_by", type_="foreignkey")
        batch.alter_column("submitted_at", existing_type=sa.DateTime(timezone=True), nullable=True)
        batch.drop_column("submitted_by")
    with op.batch_alter_table("rule_tests") as batch:
        batch.drop_index("ix_rule_tests_draft_id")
        batch.drop_column("draft_id")
    op.drop_table("drafts")
