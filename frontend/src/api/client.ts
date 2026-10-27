import type {
  AuditEvent,
  BudgetUsage,
  ConsolidatedRow,
  DryRunResult,
  ExecutionResult,
  Guardrails,
  PerformanceResponse,
  RuleDetail,
  RuleFilters,
  RuleInput,
  RuleSummary,
  User,
} from './types';
import { ApiError } from './types';
import { createMockApi } from './mock/mockApi';

/**
 * Contrat de l'API FastAPI. Le front ne parle qu'à cette interface (PRD §8.1) ;
 * deux implémentations : HTTP (production) et mock en mémoire (démo / dev).
 */
export interface Api {
  // F8 — identification
  login(matricule: string): Promise<{ user: User | null; needsProfile: boolean }>;
  completeProfile(firstName: string, lastName: string): Promise<User>;
  me(): Promise<User | null>;
  logout(): Promise<void>;
  updateProfile(firstName: string, lastName: string): Promise<User>;
  listUsers(): Promise<User[]>;

  // F1 / F5
  listRules(filters: RuleFilters): Promise<RuleSummary[]>;
  getRule(ruleId: string): Promise<RuleDetail>;
  createRule(input: RuleInput): Promise<RuleDetail>;
  /** DRAFT : modification en place. Autre statut : nouvelle version en DRAFT. */
  updateRule(ruleId: string, input: RuleInput): Promise<RuleDetail>;
  checkNameAvailable(name: string, excludeRuleId?: string): Promise<boolean>;

  // F3
  getGuardrails(): Promise<Guardrails>;
  getBudget(): Promise<BudgetUsage>;
  dryRun(sql: string, ruleId?: string): Promise<DryRunResult>;
  execute(sql: string, ruleId?: string): Promise<ExecutionResult>;

  // F4
  submitRule(ruleId: string): Promise<RuleDetail>;

  // F6 / F7
  getPerformance(ruleId: string, from: string, to: string): Promise<PerformanceResponse>;
  getConsolidated(): Promise<ConsolidatedRow[]>;

  // Audit
  listAudit(filters: { ruleId?: string; matricule?: string }): Promise<AuditEvent[]>;

  /** Présent uniquement en mode démo : simule les actions de l'équipe data en base. */
  demo?: {
    setStatus(ruleId: string, status: 'VALIDATED' | 'IN_PRODUCTION' | 'DISABLED' | 'REJECTED', reason?: string): Promise<RuleDetail>;
    reset(): Promise<void>;
  };
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include', // session = cookie HttpOnly posé par l'API
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.detail ?? res.statusText, data.code);
  return data as T;
}

function qs(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return s ? `?${s}` : '';
}

export function createHttpApi(): Api {
  return {
    login: (matricule) => http('POST', '/session', { matricule }),
    completeProfile: (firstName, lastName) => http('POST', '/me/profile', { firstName, lastName }),
    me: async () => {
      try {
        return await http<User>('GET', '/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    logout: () => http('DELETE', '/session'),
    updateProfile: (firstName, lastName) => http('PATCH', '/me', { firstName, lastName }),
    listUsers: () => http('GET', '/users'),
    listRules: (f) => http('GET', `/rules${qs({ ...f })}`),
    getRule: (id) => http('GET', `/rules/${id}`),
    createRule: (input) => http('POST', '/rules', input),
    updateRule: (id, input) => http('PUT', `/rules/${id}`, input),
    checkNameAvailable: async (name, excludeRuleId) =>
      (await http<{ available: boolean }>('GET', `/rules/name-available${qs({ name, exclude: excludeRuleId })}`)).available,
    getGuardrails: () => http('GET', '/config/guardrails'),
    getBudget: () => http('GET', '/me/budget'),
    dryRun: (sql, ruleId) => http('POST', '/query/dry-run', { sql, ruleId }),
    execute: (sql, ruleId) => http('POST', '/query/execute', { sql, ruleId }),
    submitRule: (id) => http('POST', `/rules/${id}/submit`),
    getPerformance: (id, from, to) => http('GET', `/rules/${id}/performance${qs({ from, to })}`),
    getConsolidated: () => http('GET', '/performance/production'),
    listAudit: (f) => http('GET', `/audit${qs(f)}`),
  };
}

export const API_MODE: 'mock' | 'http' = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock';

export const api: Api = API_MODE === 'http' ? createHttpApi() : createMockApi();
