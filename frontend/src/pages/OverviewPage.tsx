import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { RULE_STATUSES, type RuleFilters, type RuleStatus, type RuleSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert, Spinner, StatusBadge } from '../components/ui';
import { ACTION_LABEL } from './AuditPage';
import { fmtDate, fmtDateTime, fmtInt, fmtPct } from '../lib/format';
import { DEFAULT_WATCH_THRESHOLD, productionHealth, type ProductionHealth } from '../lib/metrics';
import { queryHash } from '../lib/sql';
import { useAsync } from '../lib/useAsync';
import { readPref, writePref } from '../prefs/prefs';

const LIST_FILTERS: RuleFilters = { q: '', status: '', typology: '', owner: '', criticality: '', sort: 'updated_desc' };

/** Brouillon dont la dernière exécution de test réussie porte sur la requête actuelle. */
function readyToSubmit(r: RuleSummary): boolean {
  const t = r.lastTest;
  return r.status === 'DRAFT' && !!t && t.success && t.phase === 'EXECUTION' && t.queryHash === queryHash(r.sqlQuery);
}

export function OverviewPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const rules = useAsync(() => api.listRules({}), []);
  const prod = useAsync(() => api.getConsolidated(), []);
  const audit = useAsync(() => api.listAudit({}), []);
  const threshold = readPref<number>('watchPrecisionThreshold', DEFAULT_WATCH_THRESHOLD);

  const health = useMemo(
    () => (prod.data ?? []).map((r) => productionHealth(r, threshold)).sort((a, b) => (a.precision ?? -1) - (b.precision ?? -1)),
    [prod.data, threshold],
  );

  /** Ouvre la liste des règles avec un filtre déjà posé. */
  const openList = (patch: Partial<RuleFilters>) => {
    writePref('rulesFilters', { ...LIST_FILTERS, ...patch });
    nav('/rules');
  };

  if (rules.error) return <Alert kind="error" title={rules.error.message} />;
  if (!rules.data) return <Spinner />;

  const all = rules.data;
  const count = (s: RuleStatus) => all.filter((r) => r.status === s).length;
  const watch = health.filter((h) => h.reasons.length);
  const myDrafts = all.filter((r) => r.status === 'DRAFT' && r.ownerMatricule === user?.matricule);
  const myReady = myDrafts.filter(readyToSubmit);
  const recent = (audit.data ?? []).filter((e) => e.action !== 'LOGIN').slice(0, 6);
  const maxStatus = Math.max(1, ...RULE_STATUSES.map(count));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vue d'ensemble</h1>
          <p>Le dispositif de détection au {fmtDate(new Date().toISOString())}.</p>
        </div>
      </div>

      <div className="stack">
        <div className="overview-kpis">
          <button type="button" className="card kpi kpi-link" onClick={() => openList({ status: 'IN_PRODUCTION' })}>
            <span className="kpi-label">En production</span>
            <span className="kpi-value">{fmtInt(count('IN_PRODUCTION'))}</span>
            <span className="kpi-sub">
              Règles exécutées par Airflow
              {count('INACTIVE') > 0 && ` · ${count('INACTIVE')} inactive${count('INACTIVE') > 1 ? 's' : ''} en plus`}
            </span>
          </button>
          <button type="button" className="card kpi kpi-link" onClick={() => openList({ status: 'SUBMITTED' })}>
            <span className="kpi-label">Soumises</span>
            <span className="kpi-value">{fmtInt(count('SUBMITTED'))}</span>
            <span className="kpi-sub">En attente de mise en production par l'équipe data</span>
          </button>
          <Link to="/production" className="card kpi kpi-link">
            <span className="kpi-label">À surveiller</span>
            <span className="kpi-value">{prod.data ? fmtInt(watch.length) : '…'}</span>
            <span className="kpi-sub">Précision sous {fmtPct(threshold)}, aucune remontée sur 30 jours ou plus exécutée par Airflow</span>
            {watch.length > 0 && <span className="kpi-flag">⚠ Action requise</span>}
          </Link>
          <button type="button" className="card kpi kpi-link" onClick={() => openList({ status: 'DRAFT', owner: user?.matricule ?? '' })}>
            <span className="kpi-label">Mes brouillons</span>
            <span className="kpi-value">{fmtInt(myDrafts.length)}</span>
            <span className="kpi-sub">
              dont {myReady.length} prêt{myReady.length > 1 ? 's' : ''} à soumettre
            </span>
          </button>
        </div>

        <div className="overview-row">
          <section className="card" aria-labelledby="ov-precision">
            <div className="card-head">
              <div>
                <h2 id="ov-precision">Précision des règles en production</h2>
                <p>30 derniers jours · confirmées frauduleuses ÷ commandes traitées · la moins précise en premier</p>
              </div>
              <Link to="/production" className="btn btn-sm">
                Détail
              </Link>
            </div>
            <div className="card-pad">
              {prod.error ? (
                <Alert kind="error" title={prod.error.message} />
              ) : !prod.data ? (
                <Spinner />
              ) : health.length === 0 ? (
                <div className="empty">Aucune règle en production.</div>
              ) : (
                <PrecisionBars rows={health} threshold={threshold} />
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="ov-lifecycle">
            <div className="card-head">
              <div>
                <h2 id="ov-lifecycle">Règles par statut</h2>
                <p>{fmtInt(all.length)} règles au total, version courante</p>
              </div>
            </div>
            <ul className="status-bars">
              {RULE_STATUSES.map((s) => (
                <li key={s}>
                  <button type="button" className="status-bar" onClick={() => openList({ status: s })} title={`Voir les règles « ${s} »`}>
                    <StatusBadge status={s} />
                    <span className="status-track" aria-hidden="true">
                      <span style={{ width: `${(count(s) / maxStatus) * 100}%` }} />
                    </span>
                    <span className="status-count">{count(s)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="overview-cols">
          <section className="card" aria-labelledby="ov-watch">
            <div className="card-head">
              <h2 id="ov-watch">À surveiller</h2>
            </div>
            {watch.length === 0 ? (
              <div className="empty">Aucune règle à surveiller.</div>
            ) : (
              <ul className="ov-list">
                {watch.map((w) => (
                  <li key={w.ruleId}>
                    <Link to={`/rules/${w.ruleId}`} className="rule-link">
                      {w.name}
                    </Link>
                    {w.reasons.map((r) => (
                      <span key={r} className="small" style={{ color: 'var(--bad)' }}>
                        {r}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="ov-drafts">
            <div className="card-head">
              <h2 id="ov-drafts">Mes brouillons</h2>
              <Link to="/rules/new" className="btn btn-sm">
                + Nouvelle règle
              </Link>
            </div>
            {myDrafts.length === 0 ? (
              <div className="empty">Aucun brouillon en cours.</div>
            ) : (
              <ul className="ov-list">
                {myDrafts.map((r) => (
                  <li key={r.ruleId}>
                    <Link to={`/rules/${r.ruleId}`} className="rule-link">
                      {r.name} <span className="muted small">v{r.version}</span>
                    </Link>
                    {readyToSubmit(r) ? (
                      <span className="small" style={{ color: 'var(--good)' }}>
                        ✓ Testée, prête à soumettre
                      </span>
                    ) : (
                      <span className="small muted">{r.lastTest ? 'Test à refaire sur la requête actuelle' : 'Jamais testée'}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="ov-activity">
            <div className="card-head">
              <h2 id="ov-activity">Activité récente</h2>
              <Link to="/audit" className="btn btn-sm">
                Journal
              </Link>
            </div>
            {recent.length === 0 ? (
              <div className="empty">Aucune activité.</div>
            ) : (
              <ul className="ov-list">
                {recent.map((e) => (
                  <li key={e.id}>
                    <span className="small">
                      <strong>{e.userName}</strong> · {ACTION_LABEL[e.action].toLowerCase()}
                      {e.ruleId && (
                        <>
                          {' '}
                          <Link to={`/rules/${e.ruleId}`}>{e.ruleName}</Link>
                          {e.version != null && <span className="muted"> v{e.version}</span>}
                        </>
                      )}
                    </span>
                    <span className="small muted">{fmtDateTime(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/** Une barre par règle, échelle 0–100 %, seuil « à surveiller » en repère. Jamais de total : les règles ne s'additionnent pas. */
function PrecisionBars({ rows, threshold }: { rows: ProductionHealth[]; threshold: number }) {
  return (
    <div className="pbars" role="table" aria-label="Taux de précision par règle en production">
      {rows.map((r) => {
        const label =
          r.precision === null
            ? r.ordersFlagged30d === 0
              ? 'Aucune remontée'
              : 'Aucune commande traitée'
            : `${fmtPct(r.precision)} — ${fmtInt(r.ordersConfirmed30d)} confirmées / ${fmtInt(r.ordersProcessed30d)} traitées`;
        return (
          <div className="pbar-row" role="row" key={r.ruleId}>
            <Link to={`/rules/${r.ruleId}`} className="pbar-name" role="rowheader" title={r.name}>
              {r.name}
            </Link>
            <div className="pbar-track" role="cell" title={label}>
              {r.precision !== null && (
                <span className={`pbar-fill${r.lowSample ? ' low' : ''}`} style={{ width: `${Math.max(r.precision * 100, 0.5)}%` }} />
              )}
              <span className="pbar-threshold" style={{ left: `${threshold * 100}%` }} aria-hidden="true" />
            </div>
            <span className="pbar-value" role="cell">
              {r.precision === null ? (
                <span style={{ color: 'var(--bad)' }}>{label}</span>
              ) : (
                <>
                  <strong>{fmtPct(r.precision)}</strong>
                  {r.lowSample && (
                    <span className="small" style={{ color: 'var(--warn)' }} title="Taux de traitement < 50 % ou moins de 20 commandes traitées">
                      {' '}
                      ⚠ échantillon faible
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
        );
      })}
      <div className="pbar-row pbar-axis" aria-hidden="true">
        <span />
        <div className="pbar-scale">
          {[0, 50, 100].map((t) => (
            <span key={t} style={{ left: `${t}%` }}>
              {t} %
            </span>
          ))}
        </div>
        <span className="small muted">┆ seuil {fmtPct(threshold)}</span>
      </div>
    </div>
  );
}
