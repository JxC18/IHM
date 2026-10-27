import { useState } from 'react';
import { api } from '../api/client';
import type { DryRunResult, ExecutionResult, SqlIssue } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { addDays, fmtBytes, fmtDuration, fmtEur, fmtInt, fmtLongDate, isoDate } from '../lib/format';
import { queryHash } from '../lib/sql';
import { Alert, Spinner } from './ui';

interface Props {
  sql: string;
  ruleId?: string;
  onIssues: (issues: SqlIssue[]) => void;
  onGoTo: (line: number, column?: number) => void;
  /** Appelé après chaque test (pour rafraîchir l'historique / l'éligibilité à la soumission). */
  onTested?: () => void;
  /** Appelé après une exécution réussie, avec l'empreinte de la requête testée. */
  onExecuted?: (hash: string) => void;
}

type Phase = 'idle' | 'dry-running' | 'dry-done' | 'executing' | 'exec-done';

export function TestPanel({ sql, ruleId, onIssues, onGoTo, onTested, onExecuted }: Props) {
  const guard = useAsync(() => api.getGuardrails(), []);
  const budget = useAsync(() => api.getBudget(), []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [dry, setDry] = useState<DryRunResult>();
  // Résultat d'exécution : uniquement en mémoire, jamais persisté (PRD §10).
  const [exec, setExec] = useState<ExecutionResult>();
  const [error, setError] = useState<string>();
  const [testedHash, setTestedHash] = useState<string>();

  const hash = queryHash(sql);
  const stale = testedHash !== undefined && testedHash !== hash;

  async function runDry() {
    setPhase('dry-running');
    setDry(undefined);
    setExec(undefined);
    setError(undefined);
    try {
      const r = await api.dryRun(sql, ruleId);
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
      setExec(await api.execute(sql, ruleId));
      setPhase('exec-done');
      onExecuted?.(hash);
      budget.reload();
    } catch (e) {
      setError((e as Error).message);
      setPhase('dry-done');
    } finally {
      onTested?.();
    }
  }

  const g = guard.data;
  const b = budget.data;
  const errors = dry?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = dry?.issues.filter((i) => i.severity === 'warning') ?? [];
  const step1 = phase === 'dry-running' ? 'active' : dry ? (dry.ok ? 'done' : 'failed') : '';
  const step2 = phase === 'executing' ? 'active' : exec ? 'done' : '';

  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={runDry} disabled={phase === 'dry-running' || phase === 'executing' || !sql.trim()}>
          {phase === 'dry-running' ? <span className="spinner" aria-hidden="true" /> : '▶'} Tester
        </button>
        <span className="small muted">Dry-run gratuit, puis exécution d'un échantillon après confirmation.</span>
        <span className="spacer" />
        {b && (
          <div style={{ minWidth: 220 }} className="small">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Budget mensuel de scan</span>
              <span>
                {fmtBytes(b.bytesUsed)} / {fmtBytes(b.budgetBytes)}
              </span>
            </div>
            <div
              className={`meter${b.bytesUsed >= b.budgetBytes ? ' over' : ''}`}
              role="meter"
              aria-label="Budget mensuel de scan consommé"
              aria-valuemin={0}
              aria-valuemax={b.budgetBytes}
              aria-valuenow={b.bytesUsed}
            >
              <span style={{ width: `${Math.min(100, (b.bytesUsed / b.budgetBytes) * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      <p className="small" style={{ margin: 0 }}>
        Le test s'exécute avec <span className="mono">@run_date</span> = <strong>{fmtLongDate(dry?.runDate ?? addDays(isoDate(new Date()), -1))}</strong>{' '}
        (la veille), comme le ferait Airflow pour le run de ce jour. La période réellement couverte dépend de la façon dont la requête
        utilise cette date.
      </p>

      {g && (
        <p className="small muted" style={{ margin: 0 }}>
          Garde-fous appliqués par le serveur : volume scanné max. <strong>{fmtBytes(g.maxBytesBilled)}</strong> · durée max.{' '}
          <strong>{fmtDuration(g.jobTimeoutMs)}</strong> · <strong>{g.maxResults}</strong> lignes affichées.
        </p>
      )}

      {stale && (
        <Alert kind="warn" title="La requête a changé depuis le dernier test.">
          Relancez le test : la soumission exige un test réussi sur la version courante.
        </Alert>
      )}
      {error && <Alert kind="error" title={error} />}

      {(dry || phase !== 'idle') && (
        <div className="steps" aria-live="polite">
          <div className={`step ${step1}`}>
            <span className="step-num">1</span>
            <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
              <h3>Dry-run</h3>
              {phase === 'dry-running' && <Spinner label="Validation de la requête…" />}
              {dry && dry.ok && (
                <dl className="kv">
                  <dt>Instruction</dt>
                  <dd className="mono">{dry.statementType}</dd>
                  <dt>Volume scanné estimé</dt>
                  <dd>
                    <strong>{fmtBytes(dry.bytesProcessed ?? 0)}</strong>
                    {g && <span className="muted"> / plafond {fmtBytes(g.maxBytesBilled)}</span>}
                  </dd>
                  <dt>Coût estimé</dt>
                  <dd>~{fmtEur(dry.estimatedCostEur ?? 0)}</dd>
                  <dt>Colonnes</dt>
                  <dd className="mono small" style={{ wordBreak: 'break-word' }}>
                    {dry.outputSchema?.map((c) => c.name).join(', ')}
                  </dd>
                </dl>
              )}
              {dry && errors.length > 0 && (
                <ul className="issue-list">
                  {errors.map((i, k) => (
                    <IssueItem key={k} issue={i} onGoTo={onGoTo} />
                  ))}
                </ul>
              )}
              {dry && warnings.length > 0 && (
                <ul className="issue-list">
                  {warnings.map((i, k) => (
                    <IssueItem key={k} issue={i} onGoTo={onGoTo} />
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className={`step ${step2}`}>
            <span className="step-num">2</span>
            <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
              <h3>Exécution échantillonnée</h3>
              {!dry || !dry.ok ? (
                <p className="small muted" style={{ margin: 0 }}>
                  Disponible une fois le dry-run réussi.
                </p>
              ) : dry.exceedsBytesLimit ? (
                <Alert kind="error" title="Exécution refusée avant lancement">
                  Volume estimé {fmtBytes(dry.bytesProcessed ?? 0)}, au-delà du plafond de {g && fmtBytes(g.maxBytesBilled)}. Restreignez la
                  période ou les tables scannées.
                </Alert>
              ) : phase === 'executing' ? (
                <Spinner label="Exécution en cours…" />
              ) : exec ? (
                <dl className="kv">
                  <dt>Lignes (requête complète)</dt>
                  <dd>
                    <strong>{fmtInt(exec.totalRows)}</strong>
                  </dd>
                  <dt>Durée réelle</dt>
                  <dd>{fmtDuration(exec.durationMs)}</dd>
                  <dt>Volume scanné réel</dt>
                  <dd>{fmtBytes(exec.bytesProcessed)}</dd>
                </dl>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  <p className="small" style={{ margin: 0 }}>
                    L'exécution scannera environ <strong>{fmtBytes(dry.bytesProcessed ?? 0)}</strong> (~{fmtEur(dry.estimatedCostEur ?? 0)}), décomptés de
                    votre budget mensuel.
                  </p>
                  <div>
                    <button type="button" className="btn btn-primary btn-sm" onClick={runExec} disabled={stale}>
                      Confirmer l'exécution
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {exec && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <h3>Échantillon</h3>
            <span className="small muted">
              {fmtInt(exec.rows.length)} ligne{exec.rows.length > 1 ? 's' : ''} affichée{exec.rows.length > 1 ? 's' : ''} sur {fmtInt(exec.totalRows)} — non
              conservées après fermeture de la page.
            </span>
          </div>
          {exec.rows.length === 0 ? (
            <div className="empty card">La requête ne remonte aucune commande.</div>
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
        </div>
      )}
    </div>
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
