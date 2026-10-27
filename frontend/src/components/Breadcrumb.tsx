import { Fragment } from 'react';
import { Link } from 'react-router-dom';

export interface Crumb {
  label: string;
  /** Absent pour la page courante, toujours en dernier. */
  to?: string;
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** Fil d'Ariane au-dessus du titre : chaque niveau parent est cliquable. */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Fil d'Ariane">
      <ol>
        {items.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <li className="crumb-sep" aria-hidden="true">
                <Chevron />
              </li>
            )}
            <li>
              {c.to ? (
                <Link to={c.to} className="crumb-link" title={c.label}>
                  {i === 0 && <span aria-hidden="true">←</span>}
                  {c.label}
                </Link>
              ) : (
                <span className="crumb-current" aria-current="page" title={c.label}>
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
