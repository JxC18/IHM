import type { DailyPerformance } from '../api/types';

/** Seuils de fiabilité du taux de précision (PRD F6, point d'attention). */
export const MIN_PROCESSING_RATE = 0.5;
export const MIN_PROCESSED_ORDERS = 20;

export interface Totals {
  flagged: number;
  processed: number;
  confirmed: number;
  processingRate: number | null;
  precision: number | null;
  /** Précision assise sur un échantillon trop faible. */
  lowSample: boolean;
}

export function totals(rows: DailyPerformance[]): Totals {
  const flagged = rows.reduce((s, r) => s + r.ordersFlagged, 0);
  const processed = rows.reduce((s, r) => s + r.ordersProcessed, 0);
  const confirmed = rows.reduce((s, r) => s + r.ordersConfirmedFraud, 0);
  const processingRate = flagged > 0 ? processed / flagged : null;
  const precision = processed > 0 ? confirmed / processed : null;
  return {
    flagged,
    processed,
    confirmed,
    processingRate,
    precision,
    lowSample: processingRate === null || processingRate < MIN_PROCESSING_RATE || processed < MIN_PROCESSED_ORDERS,
  };
}

/** Variation relative (comptages) ou absolue en points (taux). */
export function delta(cur: number | null, prev: number | null, kind: 'relative' | 'points'): number | null {
  if (cur === null || prev === null) return null;
  if (kind === 'points') return cur - prev;
  return prev === 0 ? null : (cur - prev) / prev;
}
