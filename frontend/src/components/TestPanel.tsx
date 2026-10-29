import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DryRunResult, ExecutionResult, SqlIssue, TestTarget } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { fmtBytes, fmtDuration, fmtInt, fmtLongDate, fmtPct, isoDate } from '../lib/format';
import { queryHash } from '../lib/sql';
import { Alert, Spinner } from './ui';

interface Props {
  sql: string;
  /** Brouillon ou règle testée ; absent : test libre (rattaché au brouillon à son premier enregistrement). */
  target?: TestTarget;
  onIssues: (issues: SqlIssue[]) => void;
  onGoTo: (line: number, column?: number) => void;
  /** Appelé après chaque test (pour rafraîchir l'historique / l'éligibilité à la soumission). */
  onTested?: () => void;
  /** Appelé après une exécution réussie, avec l'empreinte de la requête testée. */
  onExecuted?: (hash: string) => void;
}

type Phase = 'idle' | 'dry-running' | 'dry-done' | 'executing' | 'exec-done';

export function TestPanel({ sql, target, onIssues, onGoTo, onTested, onExecuted }: Props) {
  const guard = useAsync(() => api.getGuardrails(), []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [dry, setDry] = useState<DryRunResult>();
  // Résultat d'exécution : uniquement en mémoire, jamais persisté (PRD §10).
  const [exec, setExec] = useState<ExecutionResult>();
  const [error, setError] = useState<string>();
  const [testedHash, setTestedHash] = useState<string>();

  // Quand un résultat apparaît, la page descend jusqu'à lui (sans animation si l'utilisateur la refuse).
  const statusRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const reveal = (el: HTMLElement | null, block: ScrollLogicalPosition) =>
    el?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block });
  useEffect(() => {
    if (dry && !exec) reveal(statusRef.current, 'nearest');
  }, [dry, exec]);
  useEffect(() => {
    if (exec) reveal(resultRef.current, 'start');
  }, [exec]);

  const hash = queryHash(sql);
  const stale = testedHash !== undefined && testedHash !== hash;

  async function runDry() {
    setPhase('dry-running');
    setDry(undefined);
    setExec(undefined);
    setError(undefined);
    try {
      const r = await api.dryRun(sql, target);
      setDry(r);
      setTestedHash(hash);
      onIssues(r.issues);
      setPhase('dry-done');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    } finally {
      onTested?.();
    }
  }

  async function runExec() {
    setPhase('executing');
    setError(undefined);
    try {
      setExec(await api.execute(sql, target));
      setPhase('exec-done');
      onExecuted?.(hash);
    } catch (e) {
      setError((e as Error).message);
      setPhase('dry-done');
    } finally {
      onTested?.();
    }
  }

  const g = guard.data;
  const errors = dry?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = dry?.issues.filter((i) => i.severity === 'warning') ?? [];
  const busy = phase === 'dry-running' || phase === 'executing';
  const canExec = !!dry?.ok && !dry.exceedsBytesLimit && !stale && !busy;

  return (
    <div className="stack test-panel">
      {/* Action */}
      <div className="test-toolbar">
        <button type="button" className="btn btn-primary" onClick={runDry} disabled={busy || !sql.trim()}>
          {phase === 'dry-running' ? <span className="spinner" aria-hidden="true" /> : '▶'} {exec || dry ? 'Relancer le test' : 'Tester la requête'}
        </button>
      </div>
      <p className="small muted test-hint">
        La requête s'exécute telle quelle aujourd'hui ({fmtLongDate(isoDate(new Date()))}) ; pour la veille :{' '}
        <span className="mono">DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)</span>.
      </p>

      {stale && (
        <Alert kind="warn" title="La requête a changé depuis le dernier test.">
          Relancez le test : la soumission exige un test réussi sur la version courante.
        </Alert>
      )}
      {error && <Alert kind="error" title={error} />}

      <div aria-live="polite" className="stack" style={{ gap: 12 }} ref={statusRef}>
        {phase === 'dry-running' && <Spinner label="Validation de la requête (dry-run gratuit)…" />}

        {/* Requête refusée : les erreurs d'abord, cliquables vers la ligne fautive */}
        {dry && !dry.ok && (
          <div className="test-status bad">
            <strong>La requête ne peut pas être exécutée</strong>
            <ul className="issue-list">
              {errors.map((i, k) => (
                <IssueItem key={k} issue={i} onGoTo={onGoTo} />
              ))}
            </ul>
          </div>
        )}

        {/* Requête valide : confirmation de l'exécution, coût annoncé */}
        {dry?.ok && !exec && phase !== 'executing' && (
          dry.exceedsBytesLimit ? (
            <Alert kind="error" title={`Exécution refusée : ${fmtBytes(dry.bytesProcessed ?? 0)} à scanner, au-delà du plafond de ${g ? fmtBytes(g.maxBytesBilled) : '…'}.`}>
              Restreignez la période ou les tables scannées.
            </Alert>
          ) : (
            <div className="test-status ok">
              <span>
                <strong>✓ Requête valide.</strong> L'exécution scannera environ <strong>{fmtBytes(dry.bytesProcessed ?? 0)}</strong>.
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={runExec} disabled={!canExec}>
                Exécuter et compter les commandes
              </button>
            </div>
          )
        )}
        {phase === 'executing' && <Spinner label="Exécution et recoupement avec les autres règles…" />}

        {exec && (
          <div ref={resultRef} className="test-anchor">
            <ExecSummary exec={exec} />
          </div>
        )}

        {dry && warnings.length > 0 && (
          <ul className="issue-list">
            {warnings.map((i, k) => (
              <IssueItem key={k} issue={i} onGoTo={onGoTo} />
            ))}
          </ul>
        )}

        {exec && (
          <p className="small muted test-meta">
            {fmtDuration(exec.durationMs)} · {fmtBytes(exec.bytesProcessed)} scannés
          </p>
        )}

        {exec && (
          <details className="test-sample" open>
            <summary>
              Aperçu : {fmtInt(exec.rows.length)} ligne{exec.rows.length > 1 ? 's' : ''} sur {fmtInt(exec.totalRows)}, {exec.columns.length} colonne
              {exec.columns.length > 1 ? 's' : ''}
              <span className="small muted"> · non conservé après fermeture de la page</span>
            </summary>
            {exec.rows.length === 0 ? (
              <div className="empty">La requête ne remonte aucune commande.</div>
            ) : (
              <div className="results">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num" style={{ width: 1 }}>#</th>
                      {exec.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exec.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="num muted">{i + 1}</td>
                        {exec.columns.map((c) => (
                          <td key={c}>{String(r[c] ?? 'NULL')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * Les chiffres qui comptent : commandes remontées, dont nouvelles et déjà remontées par une autre règle
 * (table rule_alerts), avec la répartition par règle.
 */
function ExecSummary({ exec }: { exec: ExecutionResult }) {
  const total = exec.ordersFlagged;
  const already = exec.ordersAlreadyFlagged;
  const known = already != null;
  const fresh = known ? total - already : null;
  const share = (n: number) => (total > 0 ? n / total : 0);
  const maxRule = Math.max(1, ...exec.overlapRules.map((o) => o.orders));
  return (
    <section className="test-result" aria-label="Résultat du test">
      <div className="test-kpis">
        <div className="test-kpi">
          <span className="test-kpi-label">Commandes remontées</span>
          <span className="test-kpi-value">{fmtInt(total)}</span>
          <span className="test-kpi-sub">commandes distinctes</span>
        </div>
        <div className="test-kpi">
          <span className="test-kpi-label">
            <span className="legend-key key-new" aria-hidden="true" />
            Nouvelles
          </span>
          <span className="test-kpi-value">{fresh === null ? '—' : fmtInt(fresh)}</span>
          <span className="test-kpi-sub">{fresh === null ? 'recoupement indisponible' : `${fmtPct(share(fresh))} du total`}</span>
        </div>
        <div className="test-kpi">
          <span className="test-kpi-label">
            <span className="legend-key key-known" aria-hidden="true" />
            Déjà remontées ailleurs
          </span>
          <span className="test-kpi-value">{known ? fmtInt(already) : '—'}</span>
          <span className="test-kpi-sub">
            {known ? `${fmtPct(share(already))} · par une autre règle, ${exec.overlapDays} derniers jours` : 'table rule_alerts illisible'}
          </span>
        </div>
      </div>

      {known && total > 0 && (
        <div className="split-bar" role="img" aria-label={`${fmtInt(fresh!)} nouvelles, ${fmtInt(already)} déjà remontées par une autre règle`}>
          <span className="key-new" style={{ width: `${share(fresh!) * 100}%` }} />
          <span className="key-known" style={{ width: `${share(already) * 100}%` }} />
        </div>
      )}

      {exec.overlapRules.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h4 className="test-subtitle">Règles qui remontent déjà ces commandes</h4>
          <ul className="overlap-list">
            {exec.overlapRules.map((o) => (
              <li key={o.ruleId}>
                <span className="overlap-name" title={o.ruleName}>
                  {o.ruleName}
                </span>
                <span className="overlap-bar" aria-hidden="true">
                  <span style={{ width: `${(o.orders / maxRule) * 100}%` }} />
                </span>
                <span className="overlap-count">
                  {fmtInt(o.orders)} <span className="muted">· {fmtPct(share(o.orders))}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {known && total > 0 && already === 0 && <p className="small muted" style={{ margin: 0 }}>Aucune de ces commandes n'est remontée par une autre règle.</p>}
    </section>
  );
}

function IssueItem({ issue, onGoTo }: { issue: SqlIssue; onGoTo: (l: number, c?: number) => void }) {
  return (
    <li>
      <span className={`issue-sev ${issue.severity}`}>{issue.severity === 'error' ? 'Erreur' : 'Alerte'}</span>
      <span style={{ wordBreak: 'break-word' }}>
        {issue.message}{' '}
        {issue.line && (
          <button type="button" className="linkish small" onClick={() => onGoTo(issue.line!, issue.column)}>
            ligne {issue.line}
            {issue.column ? `, col. ${issue.column}` : ''}
          </button>
        )}
      </span>
    </li>
  );
}
