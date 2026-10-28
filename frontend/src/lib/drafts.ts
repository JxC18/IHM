import type { Draft } from '../api/types';
import { queryHash } from './sql';

/** Brouillon dont la dernière exécution de test réussie porte sur la requête enregistrée. */
export function readyToSubmit(d: Draft): boolean {
  const t = d.lastTest;
  return !!t && t.success && t.phase === 'EXECUTION' && t.queryHash === queryHash(d.sqlQuery);
}

/** « Nouvelle règle » ou « Nouvelle version (depuis la v2) ». */
export function draftKind(d: Draft): string {
  return d.newRule ? 'Nouvelle règle' : `Nouvelle version (depuis la v${d.baseVersion ?? d.latestVersion})`;
}
