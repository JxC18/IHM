import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { RuleDetail, RuleVersion } from '../api/types';
import { SqlEditor } from '../components/SqlEditor';
import { Breadcrumb } from '../components/Breadcrumb';
import { usePageTitle } from '../nav/history';
import { DiffView } from '../components/DiffView';
import { PerformanceDashboard } from '../components/PerformanceDashboard';
import { Alert, CriticalityBadge, idleFor, Lifecycle, Spinner, StatusBadge } from '../components/ui';
import { AuditTable } from './AuditPage';
import { SCHEDULE_LABEL, STATUS_LABEL, fmtBytes, fmtDateTime, fmtDuration, fmtEur, fmtInt } from '../lib/format';
import { queryHash } from '../lib/sql';
import { useAsync } from '../lib/useAsync';
import { usePref } from '../prefs/prefs';

type Tab = 'definition' | 'performance' | 'tests' | 'versions' | 'audit';

export function RuleDetailPage() {
  const { ruleId = '' } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const rule = useAsync(() => api.getRule(ruleId), [ruleId]);
  const [tab, setTab] = usePref<Tab>('ruleTab', 'definition');
  const [flash, setFlash] = useState<string | undefined>((loc.state as { flash?: string } | null)?.flash);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (flash) nav(loc.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePageTitle(rule.data?.name);

  if (rule.error) return <Alert kind="error" title={rule.error.message} />;
  if (!rule.data) return <Spinner />;
  const r = rule.data;

  const hash = queryHash(r.sqlQuery);
  const last = r.lastTest;
  const testOk = !!last && last.success && last.phase === 'EXECUTION' && last.queryHash === hash;
  const canSubmit = r.status === 'DRAFT' && testOk;
  const everInProduction = r.versions.some((v) => !!v.firstRunAt);

  async function submit() {
    setBusy(true);
    setActionError(undefined);
    try {
      rule.setData(await api.submitRule(r.ruleId));
      setFlash('submitted');
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tabs: [Tab, string, number?][] = [
    ['definition', 'Définition'],
    ['performance', 'Performance'],
    ['tests', 'Tests', r.tests.length],
    ['versions', 'Versions', r.versions.length],
    ['audit', 'Audit'],
  ];

  return (
    <>
      <Breadcrumb items={[{ label: 'Règles', to: '/rules' }, { label: r.name }]} />
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <h1>{r.name}</h1>
            <span className="tag">v{r.version}</span>
            <StatusBadge status={r.status} lastRunAt={r.lastRunAt} />
          </div>
          <p className="row small" style={{ gap: 14 }}>
            <span>{r.fraudTypology}</span>
            <CriticalityBadge value={r.criticality} />
            <span>{SCHEDULE_LABEL[r.schedule]}</span>
            <span>Propriétaire : {r.ownerName}</span>
            <span>Modifiée le {fmtDateTime(r.updatedAt)}</span>
          </p>
        </div>
        <div className="row">
          <Link to={`/rules/${r.ruleId}/edit`} className="btn">
            {r.status === 'DRAFT' ? 'Modifier et tester' : 'Créer une nouvelle version'}
          </Link>
          {r.status === 'DRAFT' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit || busy}
              onClick={submit}
              title={canSubmit ? undefined : 'Une exécution de test réussie sur la version courante est requise'}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              Soumettre à l'équipe data
            </button>
          )}
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 16 }}>
        {flash === 'saved' && <Alert kind="success" title="Règle enregistrée." />}
        {flash === 'submitted' && (
          <Alert kind="success" title="Règle soumise à l'équipe data.">
            Elle est visible dans <span className="mono">rules_registry</span> et n'est plus modifiable : toute modification créera une nouvelle version.
          </Alert>
        )}
        {actionError && <Alert kind="error" title={actionError} />}
        {r.status === 'INACTIVE' && r.lastRunAt && (
          <Alert kind="warn" title={`Plus exécutée par Airflow depuis ${idleFor(r.lastRunAt)}`}>
            Dernier run le {fmtDateTime(r.lastRunAt)}. Le DAG a été arrêté ou est en panne : vérifiez auprès de l'équipe data. Le statut
            redeviendra « En production » dès que les runs reprendront.
          </Alert>
        )}
        {r.productionVersion && (
          <Alert kind="info" title={`La v${r.productionVersion} tourne en production.`}>
            La v{r.version} ({STATUS_LABEL[r.status].toLowerCase()}) la remplacera dès qu'Airflow l'exécutera.
          </Alert>
        )}
        {r.status === 'DRAFT' && !testOk && (
          <Alert kind="warn" title="Pas encore soumissible">
            {!last
              ? 'Cette version n’a jamais été testée.'
              : last.queryHash !== hash
                ? 'Le dernier test ne porte pas sur la version actuelle de la requête.'
                : !last.success
                  ? 'Le dernier test a échoué.'
                  : 'Le dernier test est un dry-run : confirmez l’exécution échantillonnée.'}{' '}
            <Link to={`/rules/${r.ruleId}/edit`}>Tester la requête</Link>
          </Alert>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Sections de la règle">
        {tabs.map(([id, label, count]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className="tab" onClick={() => setTab(id)}>
            {label}
            {count !== undefined && <span className="count">{count}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'definition' && <DefinitionTab r={r} />}
        {tab === 'performance' && <PerformanceDashboard ruleId={r.ruleId} everInProduction={everInProduction} />}
        {tab === 'tests' && <TestsTab r={r} hash={hash} />}
        {tab === 'versions' && <VersionsTab r={r} />}
        {tab === 'audit' && <RuleAudit ruleId={r.ruleId} />}
      </div>

      {api.demo && <DemoPanel r={r} onChange={(d) => rule.setData(d)} />}
    </>
  );
}

function DefinitionTab({ r }: { r: RuleDetail }) {
  return (
    <div className="stack">
      <div className="card card-pad stack" style={{ gap: 12 }}>
        <Lifecycle status={r.status} lastRunAt={r.lastRunAt} />
        <p style={{ margin: 0 }}>{r.description}</p>
        <dl className="kv">
          <dt>Identifiant</dt>
          <dd className="mono small">{r.ruleId}</dd>
          <dt>Créée le</dt>
          <dd>{fmtDateTime(r.createdAt)}</dd>
          {r.submittedAt && (
            <>
              <dt>Soumise le</dt>
              <dd>{fmtDateTime(r.submittedAt)}</dd>
            </>
          )}
          <dt>DAG Airflow</dt>
          <dd className="mono small">{r.airflowDagId ?? <span className="muted">— pas encore exécutée par Airflow</span>}</dd>
          {r.firstRunAt && (
            <>
              <dt>Premier run</dt>
              <dd>{fmtDateTime(r.firstRunAt)}</dd>
              <dt>Dernier run</dt>
              <dd>{r.lastRunAt ? fmtDateTime(r.lastRunAt) : '—'}</dd>
            </>
          )}
        </dl>
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Requête SQL</h2>
        </div>
        <div className="card-pad stack">
          <SqlEditor value={r.sqlQuery} readOnly ariaLabel="Requête SQL (lecture seule)" />
        </div>
      </section>
    </div>
  );
}

function TestsTab({ r, hash }: { r: RuleDetail; hash: string }) {
  if (r.tests.length === 0) return <div className="card empty">Aucun test enregistré pour cette règle.</div>;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Historique des tests</h2>
          <p>Métadonnées uniquement : les lignes retournées ne sont jamais conservées.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Version</th>
              <th>Étape</th>
              <th>Résultat</th>
              <th className="num">Volume scanné</th>
              <th className="num">Lignes</th>
              <th className="num">Durée</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {r.tests.map((t) => (
              <tr key={t.id}>
                <td className="small nowrap">{fmtDateTime(t.at)}</td>
                <td>
                  v{t.version}
                  {t.version === r.version && t.queryHash !== hash && <span className="small muted"> (requête antérieure)</span>}
                </td>
                <td className="small">{t.phase === 'EXECUTION' ? 'Exécution' : 'Dry-run'}</td>
                <td className="small" style={{ maxWidth: 360 }}>
                  {t.success ? <span style={{ color: 'var(--good)' }}>✓ Succès</span> : <span style={{ color: 'var(--bad)' }}>✕ {t.error}</span>}
                </td>
                <td className="num small">
                  {t.bytesProcessed != null ? fmtBytes(t.bytesProcessed) : '—'}
                  {t.estimatedCostEur != null && t.phase === 'DRY_RUN' && <div className="muted">~{fmtEur(t.estimatedCostEur)}</div>}
                </td>
                <td className="num small">{t.totalRows != null ? fmtInt(t.totalRows) : '—'}</td>
                <td className="num small">{t.durationMs != null ? fmtDuration(t.durationMs) : '—'}</td>
                <td className="small nowrap">{t.byName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionsTab({ r }: { r: RuleDetail }) {
  const versions = r.versions; // plus récente d'abord
  const [a, setA] = useState(versions[1]?.version ?? versions[0].version);
  const [b, setB] = useState(versions[0].version);
  const [shown, setShown] = useState<RuleVersion | null>(null);
  const va = versions.find((v) => v.version === a)!;
  const vb = versions.find((v) => v.version === b)!;

  return (
    <div className="stack">
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Version</th>
                <th>Statut</th>
                <th>Créée le</th>
                <th>Soumise le</th>
                <th>DAG</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>
                    <strong>v{v.version}</strong>
                    {v.version === r.version && <span className="small muted"> (courante)</span>}
                  </td>
                  <td>
                    <StatusBadge status={v.status} lastRunAt={v.lastRunAt} />
                  </td>
                  <td className="small">{fmtDateTime(v.createdAt)}</td>
                  <td className="small">{v.submittedAt ? fmtDateTime(v.submittedAt) : '—'}</td>
                  <td className="small mono">{v.airflowDagId ?? '—'}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setShown(shown?.version === v.version ? null : v)} aria-expanded={shown?.version === v.version}>
                      {shown?.version === v.version ? 'Masquer' : 'Voir le SQL'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {shown && (
        <section className="card">
          <div className="card-head">
            <h3>Requête de la v{shown.version}</h3>
          </div>
          <div className="card-pad">
            <SqlEditor value={shown.sqlQuery} readOnly ariaLabel={`Requête de la version ${shown.version}`} />
          </div>
        </section>
      )}

      {versions.length > 1 ? (
        <section className="card">
          <div className="card-head">
            <h3>Comparer deux versions</h3>
            <div className="row">
              <label htmlFor="va" className="small muted">
                De
              </label>
              <select id="va" value={a} onChange={(e) => setA(Number(e.target.value))} style={{ width: 'auto' }}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              <label htmlFor="vb" className="small muted">
                à
              </label>
              <select id="vb" value={b} onChange={(e) => setB(Number(e.target.value))} style={{ width: 'auto' }}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="card-pad stack">
            <DiffView before={va.sqlQuery} after={vb.sqlQuery} />
          </div>
        </section>
      ) : (
        <p className="small muted">Une seule version : rien à comparer.</p>
      )}
    </div>
  );
}

function RuleAudit({ ruleId }: { ruleId: string }) {
  const events = useAsync(() => api.listAudit({ ruleId }), [ruleId]);
  if (!events.data) return <Spinner />;
  return (
    <div className="card">
      <AuditTable events={events.data} showRule={false} />
    </div>
  );
}

/** Mode démo uniquement : simule les écritures que l'équipe data fait en base. */
function DemoPanel({ r, onChange }: { r: RuleDetail; onChange: (d: RuleDetail) => void }) {
  const [err, setErr] = useState<string>();
  const waiting = r.versions.some((v) => v.status === 'SUBMITTED');
  const running = r.versions.find((v) => v.status === 'IN_PRODUCTION');
  const act = async (fn: (id: string) => Promise<RuleDetail>) => {
    setErr(undefined);
    try {
      onChange(await fn(r.ruleId));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="demo-panel stack" style={{ marginTop: 24, gap: 8 }}>
      <div>
        <strong>Simulation Airflow</strong>{' '}
        <span className="small muted">
          — mode démo uniquement. En réel, la plateforme lit les exécutions dans <span className="mono">rule_runs</span> : une version
          qui tourne passe « En production », une version qui ne tourne plus depuis 3 périodes passe « Inactive ».
        </span>
      </div>
      <div className="row">
        {waiting && (
          <button type="button" className="btn btn-sm" onClick={() => act(api.demo!.simulateRuns)}>
            Simuler les premiers runs Airflow
          </button>
        )}
        {running && (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => act(api.demo!.simulateStop)}>
            Simuler l'arrêt du DAG
          </button>
        )}
        {!waiting && !running && <span className="small muted">Aucune simulation possible dans cet état.</span>}
      </div>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}
