// Types du contrat front ↔ API. Ils reflètent le schéma `rules_registry`
// (PRD §7.2), à une différence près : l'identité est portée par le matricule
// (PRD §5.4, règle 1), pas par un e-mail.

export const RULE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_PRODUCTION',
  'INACTIVE',
  'REPLACED',
] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const CRITICALITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SCHEDULES = ['DAILY', 'HOURLY', 'WEEKLY'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export interface User {
  matricule: string;
  firstName: string;
  lastName: string;
}

/** Contenu éditable d'une règle (formulaire F1 + F2). */
export interface RuleInput {
  name: string;
  description: string;
  fraudTypology: string;
  criticality: Criticality;
  schedule: Schedule;
  sqlQuery: string;
}

export interface RuleVersion extends RuleInput {
  ruleId: string;
  version: number;
  status: RuleStatus;
  ownerMatricule: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** DAG, premier et dernier run : lus dans rule_runs (écrite par Airflow). */
  airflowDagId?: string;
  firstRunAt?: string;
  lastRunAt?: string;
}

/** Ligne de la liste des règles : version courante (= la plus récente). */
export interface RuleSummary extends RuleVersion {
  versionCount: number;
  /** Version qui tourne actuellement, si différente de la version courante. */
  productionVersion?: number;
  lastTest?: TestRecord;
}

export interface RuleDetail extends RuleSummary {
  versions: RuleVersion[];
  tests: TestRecord[];
}

// ---------- F3 : test de la requête ----------

export interface Guardrails {
  maxBytesBilled: number;
  jobTimeoutMs: number;
  maxResults: number;
  monthlyBudgetBytes: number;
  costPerTbEur: number;
}

export interface BudgetUsage {
  month: string;
  bytesUsed: number;
  budgetBytes: number;
}

export interface SqlIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line?: number;
  column?: number;
  /** Longueur du fragment fautif, pour le surlignage. */
  length?: number;
}

export interface DryRunResult {
  ok: boolean;
  statementType?: string;
  outputSchema?: { name: string; type: string }[];
  bytesProcessed?: number;
  estimatedCostEur?: number;
  issues: SqlIssue[];
  /** Dépassement du plafond : l'exécution sera refusée. */
  exceedsBytesLimit: boolean;
  /** Valeur de @run_date utilisée pour le test (la veille). */
  runDate: string;
  testId: string;
}

export interface ExecutionResult {
  ok: boolean;
  error?: string;
  columns: string[];
  /** Lignes d'échantillon. Jamais persistées (PRD §10). */
  rows: Record<string, unknown>[];
  totalRows: number;
  durationMs: number;
  bytesProcessed: number;
  runDate: string;
  testId: string;
}

/** Métadonnées d'un test, seules données conservées (PRD F3). */
export interface TestRecord {
  id: string;
  ruleId?: string;
  version?: number;
  queryHash: string;
  at: string;
  byMatricule: string;
  byName: string;
  phase: 'DRY_RUN' | 'EXECUTION';
  success: boolean;
  bytesProcessed?: number;
  estimatedCostEur?: number;
  durationMs?: number;
  totalRows?: number;
  error?: string;
}

// ---------- F6 / F7 : indicateurs ----------

export interface DailyPerformance {
  date: string; // YYYY-MM-DD
  ordersFlagged: number;
  ordersProcessed: number;
  ordersConfirmedFraud: number;
}

export interface RuleRun {
  runId: string;
  ruleVersion: number;
  runDate: string;
  startedAt: string;
  finishedAt?: string;
  status: 'SUCCESS' | 'FAILED';
  rowsReturned?: number;
  errorMessage?: string;
}

export interface PerformanceResponse {
  ruleId: string;
  from: string;
  to: string;
  daily: DailyPerformance[];
  previous: DailyPerformance[];
  runs: RuleRun[];
  /** Fenêtre de latence du prestataire, en jours (PRD §7.4). */
  latencyDays: number;
}

export interface ConsolidatedRow {
  ruleId: string;
  name: string;
  version: number;
  fraudTypology: string;
  criticality: Criticality;
  ownerName: string;
  status: RuleStatus;
  lastRunAt?: string;
  ordersFlagged30d: number;
  ordersProcessed30d: number;
  ordersConfirmed30d: number;
}

// ---------- F8 : audit ----------

export type AuditAction =
  | 'LOGIN'
  | 'PROFILE_UPDATE'
  | 'RULE_CREATE'
  | 'RULE_UPDATE'
  | 'RULE_NEW_VERSION'
  | 'RULE_TEST'
  | 'RULE_SUBMIT';

export interface AuditEvent {
  id: string;
  at: string;
  matricule: string;
  userName: string;
  action: AuditAction;
  ruleId?: string;
  ruleName?: string;
  version?: number;
  details?: string;
}

export interface RuleFilters {
  q?: string;
  status?: RuleStatus | '';
  typology?: string;
  owner?: string;
  criticality?: Criticality | '';
  sort?: 'updated_desc' | 'updated_asc';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
