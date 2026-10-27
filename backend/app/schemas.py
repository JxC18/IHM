"""Schémas d'échange — miroir de frontend/src/api/types.ts (JSON en camelCase)."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RuleStatus = Literal["DRAFT", "SUBMITTED", "VALIDATED", "IN_PRODUCTION", "DISABLED", "REJECTED"]
Criticality = Literal["HIGH", "MEDIUM", "LOW"]
Schedule = Literal["DAILY", "HOURLY", "WEEKLY"]
ParamType = Literal["STRING", "INT64", "FLOAT64", "DATE", "TIMESTAMP", "BOOL"]


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class UserOut(Model):
    matricule: str
    first_name: str
    last_name: str


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


class RuleParameter(Model):
    name: str
    type: ParamType
    default: str = ""
    description: str = ""


class RuleInput(Model):
    name: str = Field(max_length=200)
    description: str
    fraud_typology: str
    criticality: Criticality
    schedule: Schedule
    sql_query: str
    parameters: list[RuleParameter] = []


class TestRecord(Model):
    id: str
    rule_id: str | None = None
    version: int | None = None
    query_hash: str
    at: datetime
    by_matricule: str
    by_name: str
    phase: Literal["DRY_RUN", "EXECUTION"]
    success: bool
    bytes_processed: int | None = None
    estimated_cost_eur: float | None = None
    duration_ms: int | None = None
    total_rows: int | None = None
    error: str | None = None


class RuleVersionOut(RuleInput):
    rule_id: str
    version: int
    status: RuleStatus
    rejection_reason: str | None = None
    owner_matricule: str
    owner_name: str
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None = None
    airflow_dag_id: str | None = None


class RuleSummary(RuleVersionOut):
    version_count: int
    production_version: int | None = None
    last_test: TestRecord | None = None


class RuleDetail(RuleSummary):
    versions: list[RuleVersionOut]
    tests: list[TestRecord]


class NameAvailable(Model):
    available: bool


class Guardrails(Model):
    max_bytes_billed: int
    job_timeout_ms: int
    max_results: int
    monthly_budget_bytes: int
    cost_per_tb_eur: float


class BudgetUsage(Model):
    month: str
    bytes_used: int
    budget_bytes: int


class QueryIn(Model):
    sql: str
    parameters: list[RuleParameter] = []
    rule_id: str | None = None


class SqlIssue(Model):
    severity: Literal["error", "warning"]
    code: str
    message: str
    line: int | None = None
    column: int | None = None
    length: int | None = None


class Column(Model):
    name: str
    type: str


class DryRunResult(Model):
    ok: bool
    statement_type: str | None = None
    output_schema: list[Column] | None = None
    bytes_processed: int | None = None
    estimated_cost_eur: float | None = None
    issues: list[SqlIssue]
    exceeds_bytes_limit: bool
    test_id: str


class ExecutionResult(Model):
    ok: bool
    error: str | None = None
    columns: list[str]
    rows: list[dict]
    total_rows: int
    duration_ms: int
    bytes_processed: int
    test_id: str


class DailyPerformance(Model):
    date: date
    orders_flagged: int
    orders_processed: int
    orders_confirmed_fraud: int


class RuleRun(Model):
    run_id: str
    rule_version: int
    run_date: date
    started_at: datetime
    finished_at: datetime | None = None
    status: Literal["SUCCESS", "FAILED"]
    rows_returned: int | None = None
    error_message: str | None = None


class PerformanceResponse(Model):
    rule_id: str
    from_: date = Field(alias="from")
    to: date
    daily: list[DailyPerformance]
    previous: list[DailyPerformance]
    runs: list[RuleRun]
    latency_days: int


class ConsolidatedRow(Model):
    rule_id: str
    name: str
    version: int
    fraud_typology: str
    criticality: Criticality
    owner_name: str
    orders_flagged30d: int = Field(alias="ordersFlagged30d")
    orders_processed30d: int = Field(alias="ordersProcessed30d")
    orders_confirmed30d: int = Field(alias="ordersConfirmed30d")


class AuditEventOut(Model):
    id: str
    at: datetime
    matricule: str
    user_name: str
    action: str
    rule_id: str | None = None
    rule_name: str | None = None
    version: int | None = None
    details: str | None = None
