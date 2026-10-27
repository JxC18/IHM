import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useNavHistory } from '../nav/history';

export interface Crumb {
  label: string;
  /** Absent pour la page courante, toujours en dernier. */
  to?: string;
}

/**
 * Fil d'Ariane : un bouton « Retour » qui ramène à la page d'où l'on vient (ou, à défaut, à la
 * page parente), puis le chemin hiérarchique cliquable jusqu'à la page courante.
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  const nav = useNavigate();
  const { previous } = useNavHistory();
  const parent = [...items].reverse().find((c) => c.to);
  const back = previous ?? (parent?.to ? { path: parent.to, label: parent.label } : null);

  return (
    <nav className="crumbs" aria-label="Fil d'Ariane">
      {back && (
        <button
          type="button"
          className="crumb-back"
          onClick={() => (previous ? nav(-1) : nav(back.path))}
          title={`Revenir à : ${back.label}`}
        >
          <span aria-hidden="true">←</span> <span className="crumb-back-label">{back.label}</span>
        </button>
      )}
      <ol>
        {items.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <li className="crumb-sep" aria-hidden="true">
                ›
              </li>
            )}
            <li>
              {c.to ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span aria-current="page" title={c.label}>
                  {c.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
