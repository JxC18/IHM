import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** Libellés des pages fixes ; les pages dynamiques (une règle) déclarent le leur via usePageTitle. */
const STATIC_TITLES: Record<string, string> = {
  '/': "Vue d'ensemble",
  '/rules': 'Règles',
  '/rules/new': 'Nouvelle règle',
  '/production': 'Production',
  '/audit': "Journal d'audit",
  '/profile': 'Profil',
};

interface NavHistory {
  /** Page précédente dans la navigation de l'application, si l'on y est arrivé depuis une autre page. */
  previous: { path: string; label: string } | null;
  setTitle: (path: string, label: string) => void;
}

const Ctx = createContext<NavHistory>({ previous: null, setTitle: () => {} });

/**
 * Mémorise le parcours dans l'application pour que « Retour » ramène à la page d'où l'on vient
 * (vue d'ensemble, production, liste filtrée…) et l'annonce par son nom.
 */
export function NavHistoryProvider({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const type = useNavigationType();
  const stack = useRef<string[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [, force] = useState(0);

  useEffect(() => {
    const s = stack.current;
    const path = loc.pathname;
    if (s[s.length - 1] === path) return;
    if (type === 'POP' && s[s.length - 2] === path) s.pop();
    else if (type === 'REPLACE' && s.length) s[s.length - 1] = path;
    else s.push(path);
    force((n) => n + 1);
  }, [loc.pathname, type]);

  const setTitle = useCallback((path: string, label: string) => {
    setTitles((t) => (t[path] === label ? t : { ...t, [path]: label }));
  }, []);

  const s = stack.current;
  const prevPath = s.length > 1 ? s[s.length - 2] : null;
  const previous = prevPath ? { path: prevPath, label: titles[prevPath] ?? STATIC_TITLES[prevPath] ?? 'Page précédente' } : null;
  return <Ctx.Provider value={{ previous, setTitle }}>{children}</Ctx.Provider>;
}

export function useNavHistory() {
  return useContext(Ctx);
}

/** Déclare le nom de la page courante (onglet du navigateur et bouton « Retour » des pages suivantes). */
export function usePageTitle(label: string | undefined) {
  const { setTitle } = useNavHistory();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!label) return;
    setTitle(pathname, label);
    document.title = `${label} · Rules Manager`;
  }, [label, pathname, setTitle]);
}
