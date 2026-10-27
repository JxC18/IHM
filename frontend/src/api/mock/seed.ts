import type { AuditEvent, RuleVersion, TestRecord, User } from '../types';
import { queryHash } from '../../lib/sql';

export interface MockRule {
  ruleId: string;
  versions: RuleVersion[];
  /** Date de mise en production de chaque version (pour générer les indicateurs). */
  productionSince: Record<number, string>;
  productionUntil: Record<number, string>;
  /** Comportement simulé des indicateurs. */
  profile?: { dailyVolume: number; processingRate: number; precision: number; brokenSinceDays?: number };
}

export interface MockDb {
  schema: number;
  users: User[];
  rules: MockRule[];
  tests: TestRecord[];
  audit: AuditEvent[];
  /** Octets scannés par matricule et par mois (budget F3). */
  usage: Record<string, Record<string, number>>;
}

export const SCHEMA_VERSION = 3;

const daysAgo = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const USERS: User[] = [
  { matricule: '104233', firstName: 'Camille', lastName: 'Martin' },
  { matricule: '118870', firstName: 'Sacha', lastName: 'Bernard' },
  { matricule: '120415', firstName: 'Noa', lastName: 'Petit' },
];
const name = (m: string) => {
  const u = USERS.find((x) => x.matricule === m);
  return u ? `${u.firstName} ${u.lastName}` : 'Équipe data (base)';
};

interface Def {
  id: string;
  owner: string;
  name: string;
  description: string;
  fraudTypology: string;
  criticality: RuleVersion['criticality'];
  schedule: RuleVersion['schedule'];
  sql: string;
  parameters: RuleVersion['parameters'];
}

function v(def: Def, version: number, status: RuleVersion['status'], created: number, extra: Partial<RuleVersion> = {}): RuleVersion {
  return {
    ruleId: def.id,
    version,
    name: def.name,
    description: def.description,
    fraudTypology: def.fraudTypology,
    criticality: def.criticality,
    schedule: def.schedule,
    sqlQuery: def.sql,
    parameters: def.parameters,
    status,
    ownerMatricule: def.owner,
    ownerName: name(def.owner),
    createdAt: daysAgo(created),
    updatedAt: daysAgo(Math.max(0, created - 1)),
    ...extra,
  };
}

const R1: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e01',
  owner: '104233',
  name: 'Compte récent et panier élevé',
  description:
    "Commandes d'un montant élevé passées par un compte créé il y a moins de 24 h. Scénario typique d'ouverture de compte avec moyen de paiement volé.",
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'HIGH',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.amount_eur,
  c.account_created_at
FROM \`sales.orders\` o
JOIN \`sales.customers\` c USING (customer_id)
WHERE o.order_date = @run_date
  AND o.amount_eur >= @min_amount
  AND TIMESTAMP_DIFF(o.created_at, c.account_created_at, HOUR) < @max_account_age_h`,
  parameters: [
    { name: 'min_amount', type: 'FLOAT64', default: '500', description: 'Montant minimum de la commande (€)' },
    { name: 'max_account_age_h', type: 'INT64', default: '24', description: 'Ancienneté maximale du compte (heures)' },
  ],
};
const R1_V1_SQL = R1.sql.replace('@min_amount', '300');
const R1_V1_PARAMS = R1.parameters.filter((p) => p.name !== 'min_amount');

const R2: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e02',
  owner: '118870',
  name: 'Livraison hors pays de facturation',
  description:
    "Commandes livrées dans un pays différent de celui de l'adresse de facturation, au-dessus d'un seuil de montant.",
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.amount_eur,
  d.country AS shipping_country,
  a.country AS billing_country
FROM \`sales.orders\` o
JOIN \`sales.deliveries\` d USING (order_id)
JOIN \`sales.addresses\` a ON a.address_id = o.billing_address_id
WHERE o.order_date = @run_date
  AND d.country != a.country
  AND o.amount_eur >= @min_amount`,
  parameters: [{ name: 'min_amount', type: 'FLOAT64', default: '150', description: 'Montant minimum (€)' }],
};

const R3: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e03',
  owner: '104233',
  name: 'Tentatives de paiement multiples',
  description: 'Commandes ayant nécessité de nombreuses tentatives de paiement avant acceptation (test de cartes).',
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'MEDIUM',
  schedule: 'HOURLY',
  sql: `SELECT
  p.order_id,
  p.attempt_count,
  p.card_bin
FROM \`sales.payments\` p
JOIN \`sales.orders\` o USING (order_id)
WHERE o.order_date = @run_date
  AND p.attempt_count >= @min_attempts`,
  parameters: [{ name: 'min_attempts', type: 'INT64', default: '3', description: 'Nombre minimum de tentatives' }],
};
const R3_V2_SQL = R3.sql + `\n  AND p.status = 'ACCEPTED'`;
const R3_V2_PARAMS = [{ ...R3.parameters[0], default: '5' }];

const R4: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e04',
  owner: '120415',
  name: "Changement d'e-mail puis commande",
  description: "Commande passée moins de 2 h après un changement d'adresse e-mail du compte (prise de contrôle).",
  fraudTypology: 'Prise de contrôle de compte',
  criticality: 'HIGH',
  schedule: 'HOURLY',
  sql: `SELECT
  o.order_id,
  c.email_changed_at,
  o.created_at
FROM \`sales.orders\` o
JOIN \`sales.customers\` c USING (customer_id)
WHERE o.order_date = @run_date
  AND TIMESTAMP_DIFF(o.created_at, c.email_changed_at, MINUTE) BETWEEN 0 AND @max_delay_min`,
  parameters: [{ name: 'max_delay_min', type: 'INT64', default: '120', description: 'Délai maximal après changement (minutes)' }],
};

const R5: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e05',
  owner: '118870',
  name: 'Code promo utilisé par des comptes liés',
  description: "Même code promotionnel « premier achat » utilisé par plusieurs comptes partageant une adresse de livraison.",
  fraudTypology: 'Abus de promotion',
  criticality: 'LOW',
  schedule: 'WEEKLY',
  sql: `WITH usages AS (
  SELECT o.promo_code, o.shipping_address_id, COUNT(DISTINCT o.customer_id) AS nb_comptes
  FROM \`sales.orders\` o
  WHERE o.order_date BETWEEN DATE_SUB(@run_date, INTERVAL 7 DAY) AND @run_date
    AND o.promo_code IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  o.order_id,
  o.promo_code,
  u.nb_comptes
FROM \`sales.orders\` o
JOIN usages u USING (promo_code, shipping_address_id)
WHERE u.nb_comptes >= @min_accounts`,
  parameters: [{ name: 'min_accounts', type: 'INT64', default: '3', description: 'Nombre minimum de comptes distincts' }],
};

const R6: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e06',
  owner: '120415',
  name: 'BIN étranger et montant élevé',
  description: 'Carte émise hors UE, commande au-dessus du seuil, livrée en point relais.',
  fraudTypology: 'Fraude au moyen de paiement',
  criticality: 'HIGH',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  p.card_country,
  o.amount_eur
FROM \`sales.orders\` o
JOIN \`sales.payments\` p USING (order_id)
JOIN \`sales.deliveries\` d USING (order_id)
WHERE o.order_date = @run_date
  AND p.card_country != @home_country
  AND d.delivery_mode = 'RELAY'
  AND o.amount_eur >= @min_amount`,
  parameters: [
    { name: 'home_country', type: 'STRING', default: 'FR', description: 'Pays domestique (code ISO)' },
    { name: 'min_amount', type: 'FLOAT64', default: '400', description: 'Montant minimum (€)' },
  ],
};

const R7: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e07',
  owner: '104233',
  name: 'Adresse de livraison partagée',
  description: 'Adresse de livraison utilisée par plus de N comptes distincts sur 30 jours.',
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  COUNT(DISTINCT o.customer_id) OVER (PARTITION BY o.shipping_address_id) AS nb_comptes
FROM \`sales.orders\` o
WHERE o.order_date BETWEEN DATE_SUB(@run_date, INTERVAL 30 DAY) AND @run_date
QUALIFY nb_comptes > @max_accounts`,
  parameters: [{ name: 'max_accounts', type: 'INT64', default: '4', description: 'Seuil de comptes distincts' }],
};

const R8: Def = {
  id: '7f3c2a10-5b1e-4c8a-9d21-0a1b2c3d4e08',
  owner: '118870',
  name: 'Panier électronique multi-articles',
  description: "Brouillon : plusieurs exemplaires d'un même produit high-tech revendable, compte récent.",
  fraudTypology: 'Triangulation / revente',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sql: `SELECT
  o.order_id,
  o.item_count
FROM \`sales.orders\` o
WHERE o.order_date = @run_date
  AND o.item_count >= @min_items`,
  parameters: [{ name: 'min_items', type: 'INT64', default: '4', description: "Nombre minimum d'articles" }],
};

function passedTest(r: RuleVersion, at: number, by: string, i: number): TestRecord {
  return {
    id: `seed-test-${r.ruleId.slice(-2)}-${r.version}-${i}`,
    ruleId: r.ruleId,
    version: r.version,
    queryHash: queryHash(r.sqlQuery, r.parameters),
    at: daysAgo(at, 15),
    byMatricule: by,
    byName: name(by),
    phase: 'EXECUTION',
    success: true,
    bytesProcessed: 8.2e9 + i * 1.1e9,
    estimatedCostEur: 0.05,
    durationMs: 6400 + i * 500,
    totalRows: 280 + i * 37,
  };
}

export function buildSeed(): MockDb {
  const r1v1 = v({ ...R1, sql: R1_V1_SQL, parameters: R1_V1_PARAMS }, 1, 'DISABLED', 160, { airflowDagId: 'fraud_rule_compte_recent_v1' });
  const r1v2 = v(R1, 2, 'IN_PRODUCTION', 75, { submittedAt: daysAgo(74), airflowDagId: 'fraud_rule_compte_recent_v2' });
  const r2v1 = v(R2, 1, 'IN_PRODUCTION', 120, { submittedAt: daysAgo(119), airflowDagId: 'fraud_rule_livraison_pays' });
  const r3v1 = v(R3, 1, 'IN_PRODUCTION', 95, { submittedAt: daysAgo(94), airflowDagId: 'fraud_rule_tentatives_paiement' });
  const r3v2 = v({ ...R3, sql: R3_V2_SQL, parameters: R3_V2_PARAMS }, 2, 'DRAFT', 3);
  const r4v1 = v(R4, 1, 'IN_PRODUCTION', 140, { submittedAt: daysAgo(139), airflowDagId: 'fraud_rule_changement_email' });
  const r5v1 = v(R5, 1, 'SUBMITTED', 6, { submittedAt: daysAgo(5) });
  const r6v1 = v(R6, 1, 'VALIDATED', 12, { submittedAt: daysAgo(11) });
  const r7v1 = v(R7, 1, 'REJECTED', 20, {
    submittedAt: daysAgo(19),
    rejectionReason:
      'Fenêtre glissante de 30 jours recalculée à chaque run : coût de scan trop élevé en horaire. Proposer une version quotidienne pré-agrégée.',
  });
  const r8v1 = v(R8, 1, 'DRAFT', 1);

  const rules: MockRule[] = [
    {
      ruleId: R1.id,
      versions: [r1v1, r1v2],
      productionSince: { 1: daysAgo(150).slice(0, 10), 2: daysAgo(70).slice(0, 10) },
      productionUntil: { 1: daysAgo(71).slice(0, 10) },
      profile: { dailyVolume: 32, processingRate: 0.82, precision: 0.36 },
    },
    {
      ruleId: R2.id,
      versions: [r2v1],
      productionSince: { 1: daysAgo(115).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 14, processingRate: 0.9, precision: 0.58 },
    },
    {
      ruleId: R3.id,
      versions: [r3v1, r3v2],
      productionSince: { 1: daysAgo(90).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 95, processingRate: 0.31, precision: 0.07 },
    },
    {
      ruleId: R4.id,
      versions: [r4v1],
      productionSince: { 1: daysAgo(135).slice(0, 10) },
      productionUntil: {},
      profile: { dailyVolume: 6, processingRate: 0.95, precision: 0.71, brokenSinceDays: 41 },
    },
    { ruleId: R5.id, versions: [r5v1], productionSince: {}, productionUntil: {} },
    { ruleId: R6.id, versions: [r6v1], productionSince: {}, productionUntil: {} },
    { ruleId: R7.id, versions: [r7v1], productionSince: {}, productionUntil: {} },
    { ruleId: R8.id, versions: [r8v1], productionSince: {}, productionUntil: {} },
  ];

  const tests: TestRecord[] = [
    passedTest(r1v1, 161, '104233', 0),
    passedTest(r1v2, 76, '104233', 1),
    passedTest(r2v1, 121, '118870', 2),
    passedTest(r3v1, 96, '104233', 3),
    passedTest(r4v1, 141, '120415', 4),
    passedTest(r5v1, 6, '118870', 5),
    passedTest(r6v1, 12, '120415', 6),
    passedTest(r7v1, 20, '104233', 7),
    {
      id: 'seed-test-08-1-fail',
      ruleId: R8.id,
      version: 1,
      queryHash: 'deadbeef',
      at: daysAgo(1, 16),
      byMatricule: '118870',
      byName: name('118870'),
      phase: 'DRY_RUN',
      success: false,
      error: 'Not found: Table sales.order_items was not found at [4:6]',
    },
  ];

  const audit: AuditEvent[] = [];
  let n = 0;
  const ev = (at: string, m: string, action: AuditEvent['action'], r: RuleVersion, details?: string) =>
    audit.push({ id: `seed-audit-${n++}`, at, matricule: m, userName: name(m), action, ruleId: r.ruleId, ruleName: r.name, version: r.version, details });
  for (const rule of rules) {
    for (const ver of rule.versions) {
      ev(ver.createdAt, ver.ownerMatricule, ver.version === 1 ? 'RULE_CREATE' : 'RULE_NEW_VERSION', ver);
      if (ver.submittedAt) ev(ver.submittedAt, ver.ownerMatricule, 'RULE_SUBMIT', ver);
      if (ver.status !== 'DRAFT' && ver.status !== 'SUBMITTED')
        ev(ver.updatedAt, '000000', 'RULE_STATUS_CHANGE', ver, `→ ${ver.status} (écriture directe en base, équipe data)`);
    }
  }
  for (const t of tests) {
    const r = rules.find((x) => x.ruleId === t.ruleId)!.versions.find((x) => x.version === t.version)!;
    ev(t.at, t.byMatricule, 'RULE_TEST', r, t.success ? `${t.phase === 'EXECUTION' ? 'Exécution' : 'Dry-run'} réussi` : `Échec : ${t.error}`);
  }
  audit.sort((a, b) => b.at.localeCompare(a.at));

  return { schema: SCHEMA_VERSION, users: USERS.map((u) => ({ ...u })), rules, tests, audit, usage: {} };
}
