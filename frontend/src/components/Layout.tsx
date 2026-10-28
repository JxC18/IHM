import { NavLink, Outlet, Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { API_MODE } from '../api/client';
import { usePref } from '../prefs/prefs';
import { Initials } from './ui';
import { IconAudit, IconChart, IconCollapse, IconDraft, IconHome, IconPlus, IconRules } from './icons';

function NavItem({ to, end, icon, label }: { to: string; end?: boolean; icon: ReactNode; label: string }) {
  return (
    <NavLink to={to} end={end} title={label}>
      {icon}
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}

export function Layout() {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = usePref('sidebarCollapsed', false);
  const name = user ? `${user.firstName} ${user.lastName}` : '';
  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <a className="skip-link" href="#main">
        Aller au contenu
      </a>
      <aside className="sidebar">
        <div className="sidebar-head">
          <Link to="/" className="brand" title="Rules Manager">
            <span className="brand-mark" aria-hidden="true">R</span>
            <span className="nav-label">Rules Manager</span>
          </Link>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'}
            aria-expanded={!collapsed}
          >
            <IconCollapse collapsed={collapsed} />
          </button>
        </div>
        <Link to="/rules/new" className="btn btn-primary sidebar-cta" title="Nouvelle règle">
          <IconPlus />
          <span className="nav-label">Nouvelle règle</span>
        </Link>
        <nav className="nav" aria-label="Navigation principale">
          <NavItem to="/" end icon={<IconHome />} label="Vue d'ensemble" />
          {/* Sans `end` : reste active sur la fiche, la modification et la création d'une règle. */}
          <NavItem to="/rules" icon={<IconRules />} label="Règles" />
          <NavItem to="/drafts" icon={<IconDraft />} label="Mes brouillons" />
          <NavItem to="/production" icon={<IconChart />} label="Production" />
          <NavItem to="/audit" icon={<IconAudit />} label="Journal d'audit" />
        </nav>
        {API_MODE === 'mock' && (
          <span className="sidebar-demo nav-label" role="note">
            Mode démo — données simulées
          </span>
        )}
        {user && (
          <Link to="/profile" className="userchip" title="Profil et préférences">
            <Initials name={name} />
            <span className="nav-label user-meta">
              <span className="user-name">{name}</span>
              <span className="mono small">{user.matricule}</span>
            </span>
          </Link>
        )}
      </aside>
      <div className="content">
        <main id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
