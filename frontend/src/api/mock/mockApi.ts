// Implémentation en mémoire de l'API, pour la démo et le développement front
// sans back-end. Elle joue le rôle du serveur : l'état est persisté dans le
// localStorage *uniquement* pour que la démo survive à un rechargement.

import type { Api } from '../client';
import {
  ApiError,
  type AuditEvent,
  type DailyPerformance,
  type Guardrails,
  type RuleDetail,
  type RuleInput,
  type RuleRun,
  type RuleSummary,
  type RuleVersion,
  type TestRecord,
  type User,
} from '../types';
import { buildSeed, SCHEMA_VERSION, type MockDb, type MockRule } from './seed';
import { simulateDryRun, simulateExecution } from './bigquery';
import { queryHash } from '../../lib/sql';
import { addDays, isoDate } from '../../lib/format';

const DB_KEY = 'rm.mock.db';
const SESSION_KEY = 'rm.mock.session';
const SESSION_TTL_MS = 8 * 3600 * 1000; // 8 h glissantes (PRD F8)
const LATENCY_DAYS = 7;

const GUARDRAILS: Guardrails = {
  maxBytesBilled: 50e9,
  jobTimeoutMs: 60_000,
  maxResults: 100,
  monthlyBudgetBytes: 1e12, // à définir (PRD Q5) — valeur de démo
  costPerTbEur: 5,
};

interface Session {
  matricule: string;
  lastSeen: number;
  pendingProfile?: boolean;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : la démo fonctionne en mémoire */
  }
}

const delay = (min = 120, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function rnd(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function createMockApi(): Api {
  let db: MockDb = (() => {
    const stored = read<MockDb>(DB_KEY);
    return stored && stored.schema === SCHEMA_VERSION ? stored : buildSeed();
  })();
  let session: Session | null = read<Session>(SESSION_KEY);
  const save = () => write(DB_KEY, db);
  const saveSession = () => write(SESSION_KEY, session);

  // ---------- identité : un seul point de résolution (PRD §5.4, règle 2) ----------
  function currentUser(): User {
    if (!session || session.pendingProfile || Date.now() - session.lastSeen > SESSION_TTL_MS) {
      throw new ApiError(401, 'Session expirée ou absente.');
    }
    const user = db.users.find((u) => u.matricule === session!.matricule);
    if (!user) throw new ApiError(401, 'Utilisateur inconnu.');
    session.lastSeen = Date.now();
    saveSession();
    return user;
  }
  const fullName = (u: User) => `${u.firstName} ${u.lastName}`;

  function audit(u: User, action: AuditEvent['action'], r?: RuleVersion, details?: string) {
    db.audit.unshift({
      id: uid(),
      at: now(),
      matricule: u.matricule,
      userName: fullName(u),
      action,
      ruleId: r?.ruleId,
      ruleName: r?.name,
      version: r?.version,
      details,
    });
  }

  // ---------- règles ----------
  const findRule = (id: string): MockRule => {
    const r = db.rules.find((x) => x.ruleId === id);
    if (!r) throw new ApiError(404, 'Règle introuvable.');
    return r;
  };
  const current = (r: MockRule) => r.versions[r.versions.length - 1];

  function lastTestFor(ruleId: string, version: number): TestRecord | undefined {
    return db.tests.filter((t) => t.ruleId === ruleId && t.version === version).sort((a, b) => b.at.localeCompare(a.at))[0];
  }

  function summary(r: MockRule): RuleSummary {
    const cur = current(r);
    const prod = r.versions.find((v) => v.status === 'IN_PRODUCTION');
    return {
      ...clone(cur),
      versionCount: r.versions.length,
      productionVersion: prod && prod.version !== cur.version ? prod.version : undefined,
      lastTest: lastTestFor(r.ruleId, cur.version),
    };
  }

  function detail(r: MockRule): RuleDetail {
    return {
      ...summary(r),
      versions: clone(r.versions).reverse(),
      tests: db.tests.filter((t) => t.ruleId === r.ruleId).sort((a, b) => b.at.localeCompare(a.at)),
    };
  }

  function validateInput(input: RuleInput, excludeRuleId?: string) {
    const missing = (
      [
        ['name', 'Nom'],
        ['description', 'Description métier'],
        ['fraudTypology', 'Typologie de fraude'],
        ['criticality', 'Criticité'],
        ['schedule', "Fréquence d'exécution"],
        ['sqlQuery', 'Requête SQL'],
      ] as const
    ).filter(([k]) => !String(input[k] ?? '').trim());
    if (missing.length) throw new ApiError(422, `Champs obligatoires manquants : ${missing.map((m) => m[1]).join(', ')}.`);
    if (!nameAvailable(input.name, excludeRuleId)) throw new ApiError(409, `Une règle nommée « ${input.name.trim()} » existe déjà.`, 'NAME_TAKEN');
    // DML/DDL rejetés dès l'enregistrement ; les autres contraintes bloquent la soumission.
    const dry = simulateDryRun(input.sqlQuery, input.parameters, GUARDRAILS, 'check');
    if (dry.statementType && dry.statementType !== 'SELECT') {
      throw new ApiError(422, `Instruction ${dry.statementType} refusée : seule une instruction SELECT est autorisée.`, 'NOT_SELECT');
    }
  }

  function nameAvailable(name: string, excludeRuleId?: string) {
    const n = normalize(name.trim());
    return !db.rules.some((r) => r.ruleId !== excludeRuleId && normalize(current(r).name.trim()) === n);
  }

  // ---------- indicateurs simulés ----------
  function versionAt(r: MockRule, date: string): number | undefined {
    for (const [v, since] of Object.entries(r.productionSince)) {
      const until = r.productionUntil[Number(v)];
      if (since <= date && (!until || date <= until)) return Number(v);
    }
    return undefined;
  }

  function daily(r: MockRule, from: string, to: string): DailyPerformance[] {
    const out: DailyPerformance[] = [];
    const p = r.profile;
    const today = isoDate(new Date());
    for (let d = from; d <= to && d <= today; d = addDays(d, 1)) {
      if (!p || versionAt(r, d) === undefined) continue;
      const age = Math.round((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
      const broken = p.brokenSinceDays !== undefined && age < p.brokenSinceDays;
      const s = r.ruleId + d;
      const dow = new Date(d + 'T00:00:00').getDay();
      const weekly = dow === 0 || dow === 6 ? 1.3 : 1;
      const flagged = broken ? 0 : Math.round(p.dailyVolume * weekly * (0.55 + rnd(s + 'f') * 0.9));
      const latency = Math.min(1, age / LATENCY_DAYS);
      const processed = Math.min(flagged, Math.round(flagged * p.processingRate * latency * (0.85 + rnd(s + 'p') * 0.3)));
      const confirmed = Math.min(processed, Math.round(processed * p.precision * (0.6 + rnd(s + 'c') * 0.8)));
      out.push({ date: d, ordersFlagged: flagged, ordersProcessed: processed, ordersConfirmedFraud: confirmed });
    }
    return out;
  }

  function runs(r: MockRule, from: string, to: string): RuleRun[] {
    const out: RuleRun[] = [];
    for (const d of daily(r, from, to).reverse().slice(0, 20)) {
      const failed = rnd(r.ruleId + d.date + 'run') < 0.05;
      const start = new Date(d.date + 'T03:00:00');
      start.setMinutes(Math.floor(rnd(d.date + 'm') * 50));
      out.push({
        runId: `run_${d.date.replace(/-/g, '')}_${r.ruleId.slice(-4)}`,
        ruleVersion: versionAt(r, d.date)!,
        runDate: d.date,
        startedAt: start.toISOString(),
        finishedAt: new Date(start.getTime() + (40 + rnd(d.date) * 200) * 1000).toISOString(),
        status: failed ? 'FAILED' : 'SUCCESS',
        rowsReturned: failed ? undefined : d.ordersFlagged,
        errorMessage: failed ? 'Quota exceeded: Your project exceeded quota for concurrent queries.' : undefined,
      });
    }
    return out;
  }

  // ---------- budget ----------
  const month = () => new Date().toISOString().slice(0, 7);
  const used = (m: string) => db.usage[m]?.[month()] ?? 0;

  function recordTest(u: User, ruleId: string | undefined, sql: string, params: RuleInput['parameters'], t: Partial<TestRecord> & Pick<TestRecord, 'phase' | 'success'>): TestRecord {
    const r = ruleId ? findRule(ruleId) : undefined;
    const rec: TestRecord = {
      id: uid(),
      ruleId,
      version: r ? current(r).version : undefined,
      queryHash: queryHash(sql, params),
      at: now(),
      byMatricule: u.matricule,
      byName: fullName(u),
      ...t,
    };
    db.tests.push(rec);
    audit(
      u,
      'RULE_TEST',
      r ? current(r) : undefined,
      `${t.phase === 'EXECUTION' ? 'Exécution échantillonnée' : 'Dry-run'} ${t.success ? 'réussi' : `en échec : ${t.error ?? ''}`}`,
    );
    save();
    return rec;
  }

  const api: Api = {
    async login(matricule) {
      await delay();
      if (!/^\d{6}$/.test(matricule)) throw new ApiError(422, 'Le matricule doit comporter exactement 6 chiffres.');
      const user = db.users.find((u) => u.matricule === matricule) ?? null;
      session = { matricule, lastSeen: Date.now(), pendingProfile: !user };
      saveSession();
      if (user) {
        audit(user, 'LOGIN');
        save();
      }
      return { user, needsProfile: !user };
    },
    async completeProfile(firstName, lastName) {
      await delay();
      if (!session?.pendingProfile) throw new ApiError(400, 'Aucune première connexion en cours.');
      if (!firstName.trim() || !lastName.trim()) throw new ApiError(422, 'Nom et prénom sont obligatoires.');
      const user: User = { matricule: session.matricule, firstName: firstName.trim(), lastName: lastName.trim() };
      db.users.push(user);
      session = { matricule: user.matricule, lastSeen: Date.now() };
      saveSession();
      audit(user, 'LOGIN', undefined, 'Première connexion');
      save();
      return user;
    },
    async me() {
      await delay(60, 120);
      try {
        return currentUser();
      } catch {
        return null;
      }
    },
    async logout() {
      await delay(50, 100);
      session = null;
      saveSession();
    },
    async updateProfile(firstName, lastName) {
      await delay();
      const u = currentUser();
      if (!firstName.trim() || !lastName.trim()) throw new ApiError(422, 'Nom et prénom sont obligatoires.');
      u.firstName = firstName.trim();
      u.lastName = lastName.trim();
      audit(u, 'PROFILE_UPDATE');
      save();
      return { ...u };
    },
    async listUsers() {
      await delay(40, 80);
      currentUser();
      return clone(db.users);
    },

    async listRules(f) {
      await delay();
      currentUser();
      const q = f.q ? normalize(f.q.trim()) : '';
      const list = db.rules
        .map(summary)
        .filter(
          (r) =>
            (!q || normalize(`${r.name}\n${r.description}\n${r.sqlQuery}`).includes(q)) &&
            (!f.status || r.status === f.status) &&
            (!f.typology || r.fraudTypology === f.typology) &&
            (!f.owner || r.ownerMatricule === f.owner) &&
            (!f.criticality || r.criticality === f.criticality),
        );
      list.sort((a, b) => (f.sort === 'updated_asc' ? 1 : -1) * a.updatedAt.localeCompare(b.updatedAt));
      return list;
    },
    async getRule(id) {
      await delay();
      currentUser();
      return detail(findRule(id));
    },
    async createRule(input) {
      await delay();
      const u = currentUser();
      validateInput(input);
      const ruleId = uid();
      const t = now();
      const v: RuleVersion = {
        ...clone(input),
        name: input.name.trim(),
        ruleId,
        version: 1,
        status: 'DRAFT',
        ownerMatricule: u.matricule,
        ownerName: fullName(u),
        createdAt: t,
        updatedAt: t,
      };
      db.rules.push({ ruleId, versions: [v], productionSince: {}, productionUntil: {} });
      // Les tests lancés avant le premier enregistrement sont rattachés à la règle.
      for (const test of db.tests) {
        if (!test.ruleId && test.byMatricule === u.matricule && Date.now() - new Date(test.at).getTime() < 3600_000) {
          test.ruleId = ruleId;
          test.version = 1;
        }
      }
      audit(u, 'RULE_CREATE', v);
      save();
      return detail(findRule(ruleId));
    },
    async updateRule(id, input) {
      await delay();
      const u = currentUser();
      const r = findRule(id);
      validateInput(input, id);
      const cur = current(r);
      const t = now();
      if (cur.status === 'DRAFT') {
        Object.assign(cur, clone(input), { name: input.name.trim(), updatedAt: t });
        audit(u, 'RULE_UPDATE', cur);
      } else {
        const v: RuleVersion = {
          ...clone(input),
          name: input.name.trim(),
          ruleId: id,
          version: cur.version + 1,
          status: 'DRAFT',
          ownerMatricule: cur.ownerMatricule,
          ownerName: cur.ownerName,
          createdAt: t,
          updatedAt: t,
        };
        r.versions.push(v);
        // Les tests lancés depuis l'éditeur portaient sur ce nouveau contenu : on les rattache à la nouvelle version.
        const h = queryHash(v.sqlQuery, v.parameters);
        for (const test of db.tests) {
          if (test.ruleId === id && test.version === cur.version && test.queryHash === h && Date.now() - new Date(test.at).getTime() < 3600_000) {
            test.version = v.version;
          }
        }
        audit(u, 'RULE_NEW_VERSION', v, `Nouvelle version créée à partir de la v${cur.version} (${cur.status})`);
      }
      save();
      return detail(r);
    },
    async checkNameAvailable(name, excludeRuleId) {
      await delay(40, 90);
      return nameAvailable(name, excludeRuleId);
    },

    async getGuardrails() {
      await delay(30, 60);
      return { ...GUARDRAILS };
    },
    async getBudget() {
      await delay(30, 60);
      const u = currentUser();
      return { month: month(), bytesUsed: used(u.matricule), budgetBytes: GUARDRAILS.monthlyBudgetBytes };
    },
    async dryRun(sql, params, ruleId) {
      await delay(400, 900);
      const u = currentUser();
      const testId = uid();
      const res = simulateDryRun(sql, params, GUARDRAILS, testId);
      const firstError = res.issues.find((i) => i.severity === 'error');
      const rec = recordTest(u, ruleId, sql, params, {
        phase: 'DRY_RUN',
        success: res.ok,
        bytesProcessed: res.bytesProcessed,
        estimatedCostEur: res.estimatedCostEur,
        error: firstError?.message,
      });
      return { ...res, testId: rec.id };
    },
    async execute(sql, params, ruleId) {
      const u = currentUser();
      const dry = simulateDryRun(sql, params, GUARDRAILS, 'pre');
      if (!dry.ok) throw new ApiError(422, 'Le dry-run doit réussir avant toute exécution.');
      if (dry.exceedsBytesLimit) {
        throw new ApiError(
          422,
          `Exécution refusée : volume estimé ${(dry.bytesProcessed! / 1e9).toFixed(1)} Go, plafond ${GUARDRAILS.maxBytesBilled / 1e9} Go (maximumBytesBilled).`,
          'BYTES_LIMIT',
        );
      }
      if (used(u.matricule) + dry.bytesProcessed! > GUARDRAILS.monthlyBudgetBytes) {
        throw new ApiError(429, 'Budget mensuel de scan atteint : exécution bloquée jusqu’au mois prochain.', 'BUDGET');
      }
      await delay(900, 1800);
      const res = simulateExecution(sql, params, GUARDRAILS, dry, 'exec');
      db.usage[u.matricule] = { ...db.usage[u.matricule], [month()]: used(u.matricule) + res.bytesProcessed };
      // Seules les métadonnées sont conservées, jamais les lignes (PRD §10).
      const rec = recordTest(u, ruleId, sql, params, {
        phase: 'EXECUTION',
        success: true,
        bytesProcessed: res.bytesProcessed,
        durationMs: res.durationMs,
        totalRows: res.totalRows,
      });
      return { ...res, testId: rec.id };
    },

    async submitRule(id) {
      await delay();
      const u = currentUser();
      const r = findRule(id);
      const cur = current(r);
      if (cur.status !== 'DRAFT') throw new ApiError(409, 'Seule une version en brouillon peut être soumise.');
      const last = lastTestFor(id, cur.version);
      if (!last || !last.success || last.phase !== 'EXECUTION' || last.queryHash !== queryHash(cur.sqlQuery, cur.parameters)) {
        throw new ApiError(409, 'Le dernier test doit être une exécution réussie portant sur la version courante de la requête.', 'TEST_REQUIRED');
      }
      cur.status = 'SUBMITTED';
      cur.submittedAt = now();
      cur.updatedAt = cur.submittedAt;
      audit(u, 'RULE_SUBMIT', cur, "Notification envoyée à l'équipe data (canal à arbitrer, PRD Q6)");
      save();
      return detail(r);
    },

    async getPerformance(id, from, to) {
      await delay(200, 450);
      currentUser();
      const r = findRule(id);
      const len = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
      return {
        ruleId: id,
        from,
        to,
        daily: daily(r, from, to),
        previous: daily(r, addDays(from, -len), addDays(from, -1)),
        runs: runs(r, from, to),
        latencyDays: LATENCY_DAYS,
      };
    },
    async getConsolidated() {
      await delay(200, 400);
      currentUser();
      const to = isoDate(new Date());
      const from = addDays(to, -29);
      return db.rules
        .filter((r) => r.versions.some((v) => v.status === 'IN_PRODUCTION'))
        .map((r) => {
          const v = r.versions.find((x) => x.status === 'IN_PRODUCTION')!;
          const d = daily(r, from, to);
          return {
            ruleId: r.ruleId,
            name: v.name,
            version: v.version,
            fraudTypology: v.fraudTypology,
            criticality: v.criticality,
            ownerName: v.ownerName,
            ordersFlagged30d: d.reduce((s, x) => s + x.ordersFlagged, 0),
            ordersProcessed30d: d.reduce((s, x) => s + x.ordersProcessed, 0),
            ordersConfirmed30d: d.reduce((s, x) => s + x.ordersConfirmedFraud, 0),
          };
        });
    },

    async listAudit(f) {
      await delay();
      currentUser();
      return db.audit.filter((e) => (!f.ruleId || e.ruleId === f.ruleId) && (!f.matricule || e.matricule === f.matricule));
    },

    demo: {
      async setStatus(id, status, reason) {
        await delay();
        currentUser();
        const r = findRule(id);
        const cur = current(r);
        const allowed: Record<string, string[]> = {
          VALIDATED: ['SUBMITTED'],
          REJECTED: ['SUBMITTED'],
          IN_PRODUCTION: ['VALIDATED'],
          DISABLED: ['IN_PRODUCTION', 'VALIDATED'],
        };
        // Une version en production peut être désactivée même si une version plus récente existe.
        const target = status === 'DISABLED' ? r.versions.find((v) => v.status === 'IN_PRODUCTION') ?? cur : cur;
        if (!allowed[status].includes(target.status)) throw new ApiError(409, `Transition ${target.status} → ${status} non autorisée.`);
        const today = isoDate(new Date());
        if (status === 'IN_PRODUCTION') {
          for (const v of r.versions) {
            if (v.status === 'IN_PRODUCTION') {
              v.status = 'DISABLED';
              r.productionUntil[v.version] = addDays(today, -1);
            }
          }
          r.productionSince[target.version] = today;
          target.airflowDagId = `fraud_rule_${target.ruleId.slice(0, 8)}_v${target.version}`;
          r.profile ??= { dailyVolume: 10 + Math.round(rnd(id) * 40), processingRate: 0.75, precision: 0.2 + rnd(id + 'p') * 0.4 };
        }
        if (status === 'DISABLED' && target.status === 'IN_PRODUCTION') r.productionUntil[target.version] = today;
        target.status = status;
        target.rejectionReason = status === 'REJECTED' ? reason || 'Motif non renseigné' : undefined;
        target.updatedAt = now();
        db.audit.unshift({
          id: uid(),
          at: now(),
          matricule: '000000',
          userName: 'Équipe data (base)',
          action: 'RULE_STATUS_CHANGE',
          ruleId: id,
          ruleName: target.name,
          version: target.version,
          details: `→ ${status}${reason ? ` : ${reason}` : ''} (simulation)`,
        });
        save();
        return detail(r);
      },
      async reset() {
        db = buildSeed();
        save();
      },
    },
  };
  return api;
}
