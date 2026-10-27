import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { API_MODE } from '../api/client';
import { Initials } from './ui';

export function Layout() {
  const { user } = useAuth();
  const name = user ? `${user.firstName} ${user.lastName}` : '';
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Aller au contenu
      </a>
      <header className="topbar">
        <Link to="/rules" className="brand">
          <span className="brand-mark" aria-hidden="true">R</span>
          Rules Manager
        </Link>
        <nav className="nav" aria-label="Navigation principale">
          <NavLink to="/rules" end>
            Règles
          </NavLink>
          <NavLink to="/rules/new">Nouvelle règle</NavLink>
          <NavLink to="/production">Vue production</NavLink>
          <NavLink to="/audit">Journal d'audit</NavLink>
        </nav>
        {user && (
          <Link to="/profile" className="userchip" title="Profil et préférences">
            <Initials name={name} />
            <span className="name">
              {name} <span className="muted mono small">{user.matricule}</span>
            </span>
          </Link>
        )}
      </header>
      {API_MODE === 'mock' && (
        <div className="banner" role="note">
          <strong>Mode démo</strong> — données simulées dans le navigateur, aucun appel BigQuery.
        </div>
      )}
      <main id="main">
        <Outlet />
      </main>
    </div>
  );
}
