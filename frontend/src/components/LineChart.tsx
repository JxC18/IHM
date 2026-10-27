import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate } from '../lib/format';

export interface Point {
  date: string;
  value: number | null;
  /** Lignes secondaires de l'infobulle. */
  detail?: string;
  /** Version de la règle qui a tourné ce jour-là. */
  version?: number;
}

interface Props {
  label: string;
  points: Point[];
  format: (v: number) => string;
  /** Borne haute fixe (ex. 1 pour un taux). */
  yMax?: number;
  /** À partir de cette date, les données sont incomplètes (latence prestataire). */
  incompleteFrom?: string;
  /** Repères verticaux, ex. la date à laquelle une nouvelle version a commencé à tourner. */
  markers?: { date: string; label: string }[];
  height?: number;
}

const M = { top: 14, right: 56, bottom: 26, left: 48 };

/**
 * Couleur d'une version : rouge de la marque, bleu, vert d'eau, violet (palette validée daltonisme et
 * contraste, clair et sombre). Au-delà de 4 versions les couleurs reviennent ; le repère « vN » et la
 * légende portent toujours le numéro.
 */
export function versionColor(version: number | undefined): string {
  return version === undefined ? 'var(--series-1)' : `var(--version-${((version - 1) % 4) + 1})`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * Courbe journalière à une seule série, axe Y unique (PRD F6 : jamais de double
 * axe). Réticule + infobulle au survol et au clavier (flèches gauche/droite).
 */
export function LineChart({ label, points, format, yMax, incompleteFrom, markers = [], height = 200 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const n = points.length;
  const max = yMax ?? niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const x = (i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  // Segments continus (une valeur nulle = pas de donnée → trou dans la courbe).
  // Un tracé par version : à chaque changement, le nouveau segment repart du dernier point de l'ancien.
  const segments = useMemo(() => {
    const out: { version?: number; d: string }[] = [];
    let cur: { version?: number; d: string } | null = null;
    let last: { i: number; v: number } | null = null;
    points.forEach((p, i) => {
      if (p.value === null) {
        cur = null;
        last = null;
        return;
      }
      const pt = `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
      if (!cur || cur.version !== p.version) {
        const prev: { i: number; v: number } | null = last;
        cur = { version: p.version, d: prev ? `M${x(prev.i).toFixed(1)},${y(prev.v).toFixed(1)}L${pt}` : `M${pt}` };
        out.push(cur);
      } else {
        cur.d += `L${pt}`;
      }
      last = { i, v: p.value };
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, max]);
  const versions = [...new Set(points.filter((p) => p.value !== null && p.version !== undefined).map((p) => p.version!))].sort(
    (a, b) => a - b,
  );

  const xTicks = useMemo(() => {
    if (n === 0) return [];
    const count = Math.min(n, Math.max(2, Math.floor(iw / 90)));
    return Array.from({ length: count }, (_, k) => Math.round((k / (count - 1 || 1)) * (n - 1)));
  }, [n, iw]);

  const incIdx = incompleteFrom ? points.findIndex((p) => p.date >= incompleteFrom) : -1;
  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--)
    if (points[i].value !== null) {
      lastIdx = i;
      break;
    }

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - M.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  function onKey(e: KeyboardEvent) {
    if (!n) return;
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  }

  const hp = hover !== null ? points[hover] : null;

  if (n === 0) return <div className="empty">Aucune donnée sur la période.</div>;

  return (
    <div className="chart" ref={wrap}>
      {versions.length > 1 && (
        <ul className="chart-legend" aria-label="Versions">
          {versions.map((v) => (
            <li key={v}>
              <span className="legend-key" style={{ background: versionColor(v) }} aria-hidden="true" />v{v}
            </li>
          ))}
        </ul>
      )}
      <svg
        height={height}
        role="img"
        aria-label={`${label}, du ${fmtDate(points[0].date)} au ${fmtDate(points[n - 1].date)}. Utilisez les flèches pour parcourir les valeurs.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {incIdx >= 0 && (
          <g>
            <rect className="incomplete" x={x(incIdx) - (n > 1 ? iw / (n - 1) / 2 : 0)} y={M.top} width={M.left + iw - x(incIdx) + (n > 1 ? iw / (n - 1) / 2 : 0)} height={ih} />
            <text className="incomplete-label" x={M.left + iw} y={M.top + 11} textAnchor="end">
              données incomplètes
            </text>
          </g>
        )}
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(points[i].date + 'T00:00:00'))}
            </text>
          ))}
        </g>
        {markers.map((m) => {
          const i = points.findIndex((p) => p.date === m.date);
          if (i < 0) return null;
          return (
            <g key={m.date} className="marker">
              <line x1={x(i)} x2={x(i)} y1={M.top} y2={M.top + ih} />
              <text x={x(i) + 5} y={M.top + 11}>
                {m.label}
              </text>
            </g>
          );
        })}
        {segments.map((s, k) => (
          <path key={k} className="line" d={s.d} style={{ stroke: versionColor(s.version) }} />
        ))}
        {lastIdx >= 0 && (
          <>
            <circle className="dot" cx={x(lastIdx)} cy={y(points[lastIdx].value!)} r={4} style={{ fill: versionColor(points[lastIdx].version) }} />
            <text className="end-label" x={x(lastIdx) + 8} y={y(points[lastIdx].value!) + 4}>
              {format(points[lastIdx].value!)}
            </text>
          </>
        )}
        {hp && (
          <g>
            <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={M.top} y2={M.top + ih} />
            {hp.value !== null && <circle className="dot" cx={x(hover!)} cy={y(hp.value)} r={5} style={{ fill: versionColor(hp.version) }} />}
          </g>
        )}
        <rect
          x={M.left - 6}
          y={0}
          width={iw + 12}
          height={height}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hp && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(x(hover!), 80), width - 80), top: hp.value !== null ? y(hp.value) - 10 : M.top + ih / 2 }}
          aria-live="polite"
        >
          <div>
            <span className="tt-key" aria-hidden="true" style={{ background: versionColor(hp.version) }} />
            <strong>{hp.value === null ? 'n/d' : format(hp.value)}</strong>
          </div>
          <div className="muted">{fmtDate(hp.date)}</div>
          {hp.detail && <div className="muted">{hp.detail}</div>}
          {hp.version !== undefined && <div className="muted">Version v{hp.version}</div>}
          {incompleteFrom && hp.date >= incompleteFrom && <div className="muted">Traitement prestataire en cours</div>}
        </div>
      )}
    </div>
  );
}
