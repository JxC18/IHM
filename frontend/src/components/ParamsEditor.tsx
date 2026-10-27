import { PARAM_TYPES, type ParamType, type RuleParameter } from '../api/types';
import { findParams, RUN_DATE_PARAM } from '../lib/sql';

interface Props {
  sql: string;
  value: RuleParameter[];
  onChange?: (v: RuleParameter[]) => void;
  readOnly?: boolean;
}

export function ParamsEditor({ sql, value, onChange, readOnly }: Props) {
  const used = new Set(findParams(sql).map((p) => p.name));
  const declared = new Set(value.map((p) => p.name));
  const undeclared = [...used].filter((n) => n !== RUN_DATE_PARAM && !declared.has(n));

  const update = (i: number, patch: Partial<RuleParameter>) =>
    onChange?.(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange?.(value.filter((_, j) => j !== i));
  const add = (name = '') => onChange?.([...value, { name, type: 'STRING', default: '', description: '' }]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="table-wrap">
        <table className="data params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>Nom</th>
              <th style={{ width: '14%' }}>Type</th>
              <th style={{ width: '18%' }}>Valeur par défaut</th>
              <th>Description</th>
              <th style={{ width: 90 }}>Usage</th>
              {!readOnly && <th style={{ width: 40 }}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">@{RUN_DATE_PARAM}</td>
              <td className="mono">DATE</td>
              <td className="muted small">fourni par Airflow</td>
              <td className="muted small">Paramètre réservé : date d'exécution du run. Obligatoire dans la requête.</td>
              <td>
                {used.has(RUN_DATE_PARAM) ? (
                  <span className="small" style={{ color: 'var(--good)' }}>✓ utilisé</span>
                ) : (
                  <span className="small" style={{ color: 'var(--bad)' }}>✕ absent</span>
                )}
              </td>
              {!readOnly && <td />}
            </tr>
            {value.map((p, i) => {
              const nameId = `param-${i}-name`;
              return (
                <tr key={i}>
                  <td>
                    {readOnly ? (
                      <span className="mono">@{p.name}</span>
                    ) : (
                      <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                        <span className="mono muted" aria-hidden="true">@</span>
                        <input
                          id={nameId}
                          type="text"
                          className="mono"
                          aria-label={`Nom du paramètre ${i + 1}`}
                          value={p.name}
                          onChange={(e) => update(i, { name: e.target.value.replace(/^@/, '') })}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    {readOnly ? (
                      <span className="mono">{p.type}</span>
                    ) : (
                      <select aria-label={`Type du paramètre ${p.name || i + 1}`} value={p.type} onChange={(e) => update(i, { type: e.target.value as ParamType })}>
                        {PARAM_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {readOnly ? (
                      <span className="mono">{p.default || '—'}</span>
                    ) : (
                      <input
                        type="text"
                        className="mono"
                        aria-label={`Valeur par défaut de ${p.name || `paramètre ${i + 1}`}`}
                        value={p.default}
                        onChange={(e) => update(i, { default: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {readOnly ? (
                      p.description || <span className="muted">—</span>
                    ) : (
                      <input
                        type="text"
                        aria-label={`Description de ${p.name || `paramètre ${i + 1}`}`}
                        value={p.description}
                        onChange={(e) => update(i, { description: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {!p.name ? null : used.has(p.name) ? (
                      <span className="small" style={{ color: 'var(--good)' }}>✓ utilisé</span>
                    ) : (
                      <span className="small" style={{ color: 'var(--warn)' }}>! inutilisé</span>
                    )}
                  </td>
                  {!readOnly && (
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" aria-label={`Supprimer le paramètre ${p.name}`} onClick={() => remove(i)}>
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => add()}>
            + Ajouter un paramètre
          </button>
          {undeclared.length > 0 && (
            <>
              <span className="small" style={{ color: 'var(--bad)' }}>
                Non déclaré{undeclared.length > 1 ? 's' : ''} : {undeclared.map((n) => `@${n}`).join(', ')}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onChange?.([...value, ...undeclared.map((name) => ({ name, type: 'STRING' as const, default: '', description: '' }))])}
              >
                Déclarer {undeclared.length > 1 ? 'ces paramètres' : 'ce paramètre'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
