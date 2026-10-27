// Icônes de navigation (trait 1.75, 20 px), décoratives : le libellé porte le sens.
const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const IconRules = () => (
  <svg {...base}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.2" />
    <circle cx="4.5" cy="12" r="1.2" />
    <circle cx="4.5" cy="18" r="1.2" />
  </svg>
);
export const IconPlus = () => (
  <svg {...base}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
export const IconChart = () => (
  <svg {...base}>
    <path d="M4 19h16" />
    <path d="M5 15l4-4 3 3 6-7" />
  </svg>
);
export const IconAudit = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const IconCollapse = ({ collapsed }: { collapsed: boolean }) => (
  <svg {...base}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9 4.5v15" />
    <path d={collapsed ? 'M13 10l2 2-2 2' : 'M15 10l-2 2 2 2'} />
  </svg>
);
