import { describe, expect, it } from 'vitest';
import { checkParams, findParams, maskSql, queryHash } from '../lib/sql';
import { diffLines } from '../lib/diff';
import { totals } from '../lib/metrics';
import { simulateDryRun } from '../api/mock/bigquery';
import type { Guardrails } from '../api/types';

const G: Guardrails = { maxBytesBilled: 50e9, jobTimeoutMs: 60000, maxResults: 100, monthlyBudgetBytes: 1e12, costPerTbEur: 5 };

describe('paramètres nommés', () => {
  it('ignore les @ dans les chaînes et commentaires', () => {
    const sql = "SELECT order_id FROM t -- @nope\nWHERE a = '@str' AND d = @run_date AND x > @seuil";
    expect(findParams(sql).map((x) => x.name)).toEqual(['run_date', 'seuil']);
  });
  it('ignore les variables système @@', () => {
    expect(findParams('SELECT @@project_id, @a')).toHaveLength(1);
  });
  it('refuse tout paramètre autre que @run_date et exige @run_date', () => {
    expect(checkParams('SELECT order_id WHERE x > @seuil').map((i) => i.code)).toEqual(['PARAM_NOT_ALLOWED', 'RUN_DATE_MISSING']);
    expect(checkParams('SELECT order_id WHERE d = @run_date')).toEqual([]);
  });
  it('masque en conservant les positions', () => {
    const sql = "a /* x */ 'yy' b";
    expect(maskSql(sql)).toHaveLength(sql.length);
  });
  it('empreinte insensible aux espaces, sensible au contenu', () => {
    expect(queryHash('SELECT  1')).toBe(queryHash('SELECT 1\n'));
    expect(queryHash('SELECT 1')).not.toBe(queryHash('SELECT 2'));
  });
});

describe('dry-run simulé', () => {
  const ok = 'SELECT o.order_id FROM `sales.orders` o WHERE o.order_date = @run_date';
  it('accepte une requête conforme', () => {
    const r = simulateDryRun(ok, G, 't');
    expect(r.ok).toBe(true);
    expect(r.statementType).toBe('SELECT');
    expect(r.outputSchema?.map((c) => c.name)).toContain('order_id');
  });
  it('rejette le DML', () => {
    const r = simulateDryRun('DELETE FROM `sales.orders` WHERE true', G, 't');
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe('NOT_SELECT');
  });
  it('exige order_id en sortie', () => {
    const r = simulateDryRun('SELECT o.customer_id FROM `sales.orders` o WHERE o.order_date = @run_date', G, 't');
    expect(r.issues.map((i) => i.code)).toContain('NO_ORDER_ID');
  });
  it('signale une table inconnue avec sa position', () => {
    const r = simulateDryRun('SELECT order_id\nFROM `sales.nope` WHERE d = @run_date', G, 't');
    const i = r.issues.find((x) => x.code === 'NOT_FOUND')!;
    expect(i.line).toBe(2);
    expect(i.column).toBe(6);
  });
  it('signale les dates en dur sans bloquer le test', () => {
    const r = simulateDryRun("SELECT order_id FROM `sales.orders` WHERE order_date = DATE '2026-01-01' AND x = @run_date", G, 't');
    expect(r.issues.find((i) => i.code === 'HARDCODED_DATE')?.severity).toBe('warning');
    expect(r.ok).toBe(true);
  });
  it('signale un dépassement du plafond de volume', () => {
    const r = simulateDryRun('SELECT order_id FROM `tracking.web_events_raw` WHERE d = @run_date', G, 't');
    expect(r.ok).toBe(true);
    expect(r.exceedsBytesLimit).toBe(true);
  });
});

describe('diff et indicateurs', () => {
  it('diff ligne à ligne', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc');
    expect(d.map((l) => l.kind)).toEqual(['same', 'del', 'add', 'same']);
  });
  it('précision calculée sur les traitées, échantillon faible signalé', () => {
    const t = totals([{ date: '2026-01-01', ordersFlagged: 100, ordersProcessed: 10, ordersConfirmedFraud: 5 }]);
    expect(t.precision).toBe(0.5);
    expect(t.processingRate).toBe(0.1);
    expect(t.lowSample).toBe(true);
  });
});
