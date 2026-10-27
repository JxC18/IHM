import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { CRITICALITIES, SCHEDULES, type RuleDetail, type RuleInput, type SqlIssue } from '../api/types';
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor';
import { TestPanel } from '../components/TestPanel';
import { Breadcrumb } from '../components/Breadcrumb';
import { usePageTitle } from '../nav/history';
import { Alert, Spinner, StatusBadge } from '../components/ui';
import { CRITICALITY_LABEL, FRAUD_TYPOLOGIES, SCHEDULE_LABEL, STATUS_LABEL, fmtDateTime } from '../lib/format';
import { checkParams, queryHash } from '../lib/sql';
import { readPref, writePref } from '../prefs/prefs';

const EMPTY: RuleInput = {
  name: '',
  description: '',
  fraudTypology: '',
  criticality: 'MEDIUM',
  schedule: 'DAILY',
  sqlQuery: `SELECT
  o.order_id
FROM \`sales.orders\` o
WHERE o.order_date = @run_date
`,
};

const toInput = (r: RuleDetail): RuleInput => ({
  name: r.name,
  description: r.description,
  fraudTypology: r.fraudTypology,
  criticality: r.criticality,
  schedule: r.schedule,
  sqlQuery: r.sqlQuery,
});

const same = (a: RuleInput, b: RuleInput) => JSON.stringify(a) === JSON.stringify(b);

interface StoredDraft {
  form: RuleInput;
  savedAt: string;
}

export function RuleEditorPage() {
  const { ruleId } = useParams();
  const nav = useNavigate();
  const draftKey = `editorDraft.${ruleId ?? 'new'}`;

  const [rule, setRule] = useState<RuleDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [base, setBase] = useState<RuleInput>(EMPTY);
  const [form, setForm] = useState<RuleInput>(EMPTY);
  const [restorable, setRestorable] = useState<StoredDraft | null>(null);
  const [dryIssues, setDryIssues] = useState<SqlIssue[]>();
  const [execHash, setExecHash] = useState<string>();
  const [nameTaken, setNameTaken] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string>();
  const editor = useRef<SqlEditorHandle>(null);

  // Chargement + proposition de restaurer un brouillon non enregistré (localStorage).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initial = EMPTY;
      if (ruleId) {
        try {
          const r = await api.getRule(ruleId);
          if (cancelled) return;
          setRule(r);
          initial = toInput(r);
        } catch (e) {
          setLoadError((e as Error).message);
          return;
        }
      }
      setBase(initial);
      setForm(initial);
      const stored = readPref<StoredDraft | null>(draftKey, null);
      if (stored && !same(stored.form, initial)) setRestorable(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [ruleId, draftKey]);

  const dirty = !same(form, base);

  // Sauvegarde locale du texte non enregistré.
  useEffect(() => {
    if (!dirty || restorable) return;
    const t = setTimeout(() => writePref(draftKey, { form, savedAt: new Date().toISOString() } satisfies StoredDraft), 500);
    return () => clearTimeout(t);
  }, [form, dirty, draftKey, restorable]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Unicité du nom.
  useEffect(() => {
    const name = form.name.trim();
    if (!name) return setNameTaken(false);
    const t = setTimeout(() => api.checkNameAvailable(name, ruleId).then((ok) => setNameTaken(!ok)), 300);
    return () => clearTimeout(t);
  }, [form.name, ruleId]);

  const paramIssues = useMemo(() => checkParams(form.sqlQuery), [form.sqlQuery]);
  const hash = queryHash(form.sqlQuery);
  const editorIssues = dryIssues ?? paramIssues;

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSql = (v: string) => {
    setDryIssues(undefined); // les positions ne sont plus valides
    set('sqlQuery', v);
  };

  const missing = {
    name: !form.name.trim(),
    description: !form.description.trim(),
    fraudTypology: !form.fraudTypology,
    sqlQuery: !form.sqlQuery.trim(),
  };
  const formValid = !Object.values(missing).some(Boolean) && !nameTaken;
  // Seule une version qui a tourné dans Airflow est figée ; une version soumise jamais exécutée se modifie sur place.
  const createsVersion = rule && rule.status !== 'DRAFT' && rule.status !== 'SUBMITTED';
  const withdraws = rule?.status === 'SUBMITTED';
  usePageTitle(rule ? `${createsVersion ? 'Nouvelle version' : 'Modifier'} · ${rule.name}` : ruleId ? undefined : 'Nouvelle règle');
  const canSubmit = formValid && execHash === hash && !paramIssues.some((i) => i.severity === 'error');

  async function persist(): Promise<RuleDetail> {
    if (rule && !dirty) return rule;
    const r = rule ? await api.updateRule(rule.ruleId, form) : await api.createRule(form);
    writePref(draftKey, null);
    setBase(form);
    return r;
  }

  async function save(e?: FormEvent, andSubmit = false) {
    e?.preventDefault();
    setSubmitted(true);
    if (!formValid) return;
    setSaving(andSubmit ? 'submit' : 'save');
    setError(undefined);
    try {
      let r = await persist();
      if (andSubmit) r = await api.submitRule(r.ruleId);
      nav(`/rules/${r.ruleId}`, { state: { flash: andSubmit ? 'submitted' : 'saved' } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (loadError) return <Alert kind="error" title={loadError} />;
  if (ruleId && !rule) return <Spinner />;

  const err = (k: keyof typeof missing) => submitted && missing[k];

  return (
    <form onSubmit={save} noValidate>
      <div className="page-head">
        <div>
          <Breadcrumb
            items={
              rule
                ? [
                    { label: 'Règles', to: '/rules' },
                    { label: rule.name, to: `/rules/${rule.ruleId}` },
                    { label: createsVersion ? 'Nouvelle version' : 'Modifier' },
                  ]
                : [{ label: 'Règles', to: '/rules' }, { label: 'Nouvelle règle' }]
            }
          />
          <h1>{rule ? (createsVersion ? `Nouvelle version — ${rule.name}` : `Modifier — ${rule.name}`) : 'Nouvelle règle'}</h1>
          <p>Décrivez la règle, écrivez la requête, testez-la, puis soumettez-la à l'équipe data.</p>
        </div>
        <div className="row">
          <Link to={rule ? `/rules/${rule.ruleId}` : '/rules'} className="btn">
            Annuler
          </Link>
          <button type="submit" className="btn" disabled={!!saving}>
            {saving === 'save' && <span className="spinner" aria-hidden="true" />}
            Enregistrer le brouillon
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!saving || !canSubmit}
            title={canSubmit ? undefined : 'Une exécution de test réussie sur la requête actuelle est requise'}
            onClick={() => save(undefined, true)}
          >
            {saving === 'submit' && <span className="spinner" aria-hidden="true" />}
            Enregistrer et soumettre
          </button>
        </div>
      </div>

      <div className="stack">
        {restorable && (
          <Alert kind="info" title="Un brouillon non enregistré a été retrouvé sur ce poste.">
            <div className="row" style={{ marginTop: 6 }}>
              <span className="small muted">Dernière saisie : {fmtDateTime(restorable.savedAt)}</span>
              <button type="button" className="btn btn-sm" onClick={() => { setForm(restorable.form); setRestorable(null); }}>
                Restaurer
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { writePref(draftKey, null); setRestorable(null); }}>
                Ignorer
              </button>
            </div>
          </Alert>
        )}
        {withdraws && (
          <Alert kind="info" title={`La v${rule.version} est soumise mais pas encore en production : vous pouvez la modifier.`}>
            L'enregistrement la repasse en brouillon (toujours v{rule.version}) et l'équipe data est prévenue que la soumission est retirée.
            Il faudra la retester puis la soumettre à nouveau.
          </Alert>
        )}
        {createsVersion && (
          <Alert kind="warn" title={`La version v${rule.version} est « ${STATUS_LABEL[rule.status]} » et n'est plus modifiable.`}>
            L'enregistrement créera la version <strong>v{rule.version + 1}</strong> en brouillon. La v{rule.version} reste inchangée
            {rule.status === 'IN_PRODUCTION' ? ' et continue de tourner en production' : ''}.
          </Alert>
        )}
        {error && <Alert kind="error" title={error} />}

        <section className="card" aria-labelledby="sec-def">
          <div className="card-head">
            <h2 id="sec-def">Définition</h2>
            {rule && <StatusBadge status={createsVersion || withdraws ? 'DRAFT' : rule.status} />}
          </div>
          <div className="card-pad form-grid">
            <div className="field span-2">
              <label htmlFor="name">
                Nom<span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id="name"
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={err('name') || nameTaken}
                aria-describedby="name-msg"
                required
              />
              <span id="name-msg" className={err('name') || nameTaken ? 'error-text' : 'hint'}>
                {nameTaken ? 'Une autre règle porte déjà ce nom.' : err('name') ? 'Le nom est obligatoire.' : 'Unique sur la plateforme.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="typology">
                Typologie de fraude<span className="req" aria-hidden="true">*</span>
              </label>
              <select id="typology" value={form.fraudTypology} onChange={(e) => set('fraudTypology', e.target.value)} aria-invalid={err('fraudTypology')} required>
                <option value="">— Choisir —</option>
                {FRAUD_TYPOLOGIES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              {err('fraudTypology') && <span className="error-text">La typologie est obligatoire.</span>}
            </div>
            <div className="field span-2">
              <label htmlFor="description">
                Description métier<span className="req" aria-hidden="true">*</span>
              </label>
              <textarea
                id="description"
                rows={3}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                aria-invalid={err('description')}
                aria-describedby="desc-msg"
                required
              />
              <span id="desc-msg" className={err('description') ? 'error-text' : 'hint'}>
                {err('description') ? 'La description est obligatoire.' : 'Le scénario de fraude visé, en français. Ces descriptions serviront d’exemples à l’assistant LLM de la V2.'}
              </span>
            </div>
            <div className="stack" style={{ gap: 14 }}>
              <fieldset className="field" style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend className="label">
                  Criticité<span className="req" aria-hidden="true">*</span>
                </legend>
                <div className="seg" style={{ marginTop: 4 }}>
                  {CRITICALITIES.map((c) => (
                    <button type="button" key={c} aria-pressed={form.criticality === c} onClick={() => set('criticality', c)}>
                      {CRITICALITY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="schedule">
                  Fréquence d'exécution souhaitée<span className="req" aria-hidden="true">*</span>
                </label>
                <select id="schedule" value={form.schedule} onChange={(e) => set('schedule', e.target.value as RuleInput['schedule'])}>
                  {SCHEDULES.map((s) => (
                    <option key={s} value={s}>
                      {SCHEDULE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="sec-sql">
          <div className="card-head">
            <div>
              <h2 id="sec-sql">Requête SQL</h2>
              <p>
                Une seule instruction <span className="mono">SELECT</span>, exposant <span className="mono">order_id</span>. Les seuils s'écrivent
                directement dans la requête (ex. <span className="mono">amount_eur &gt;= 500</span>) ; seule la date du run est un paramètre,{' '}
                <span className="mono">@run_date</span>, fourni par Airflow à chaque exécution.
              </p>
            </div>
          </div>
          <div className="card-pad stack">
            <SqlEditor ref={editor} value={form.sqlQuery} onChange={setSql} issues={editorIssues} ariaLabel="Requête SQL (GoogleSQL)" />
            {err('sqlQuery') && <span className="error-text">La requête est obligatoire.</span>}
            {paramIssues.length > 0 && (
              <ul className="issue-list" aria-label="Contrôles des paramètres">
                {paramIssues.map((i, k) => (
                  <li key={k}>
                    <span className={`issue-sev ${i.severity}`}>{i.severity === 'error' ? 'Erreur' : 'Alerte'}</span>
                    <span>
                      {i.message}{' '}
                      {i.line && (
                        <button type="button" className="linkish small" onClick={() => editor.current?.goTo(i.line!, i.column)}>
                          ligne {i.line}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="sec-test">
          <div className="card-head">
            <div>
              <h2 id="sec-test">Test</h2>
              <p>Le test porte sur la requête affichée, enregistrée ou non. Seules ses métadonnées sont conservées.</p>
            </div>
          </div>
          <div className="card-pad">
            <TestPanel
              sql={form.sqlQuery}
              ruleId={rule?.ruleId}
              onIssues={setDryIssues}
              onGoTo={(l, c) => editor.current?.goTo(l, c)}
              onExecuted={setExecHash}
            />
          </div>
        </section>

        <div className="row">
          <span className="small muted">
            {dirty ? 'Modifications non enregistrées (conservées localement sur ce poste).' : 'Aucune modification.'}
          </span>
          <span className="spacer" />
          <button type="submit" className="btn" disabled={!!saving}>
            Enregistrer le brouillon
          </button>
          <button type="button" className="btn btn-primary" disabled={!!saving || !canSubmit} onClick={() => save(undefined, true)}>
            Enregistrer et soumettre
          </button>
        </div>
        {!canSubmit && (
          <p className="small muted" style={{ margin: 0, textAlign: 'right' }}>
            La soumission exige tous les champs obligatoires et une exécution de test réussie sur la requête actuelle.
          </p>
        )}
      </div>
    </form>
  );
}
