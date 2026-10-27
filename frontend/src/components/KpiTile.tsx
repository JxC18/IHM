import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Variation vs période précédente, déjà formatée ; null = non calculable. */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' } | null;
  flag?: ReactNode;
}

/** Tuile d'indicateur : le chiffre, sa variation (libellée, pas seulement colorée) et un éventuel signalement. */
export function KpiTile({ label, value, sub, delta, flag }: Props) {
  return (
    <div className="card kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {delta !== undefined && (
        <span className="kpi-delta">
          {delta === null ? (
            <span className="muted">— pas de période de comparaison</span>
          ) : (
            <>
              <span aria-hidden="true">{delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'}</span> {delta.text}{' '}
              <span className="muted">vs période précédente</span>
            </>
          )}
        </span>
      )}
      {sub && <span className="kpi-sub">{sub}</span>}
      {flag && <span className="kpi-flag">⚠ {flag}</span>}
    </div>
  );
}
