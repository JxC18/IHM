import type { SqlIssue } from '../api/types';

/** Paramètre réservé, fourni par Airflow à chaque exécution (PRD F2, contrainte 3). */
export const RUN_DATE_PARAM = 'run_date';

/**
 * Remplace commentaires et littéraux par des espaces, en conservant les
 * positions, pour que les recherches ne matchent pas à l'intérieur.
 * `keepStrings` laisse les littéraux chaîne intacts.
 */
export function maskSql(sql: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || c === '#') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j += sql[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, sql.length);
      const chunk = sql.slice(i, stop);
      // Les identifiants entre backticks restent visibles : ce sont des noms de tables.
      out += c === '`' || keepStrings ? chunk : c + blank(chunk.slice(1, -1)) + (stop > i + 1 ? c : '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function offsetToLineCol(sql: string, offset: number): { line: number; column: number } {
  const before = sql.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return { line, column };
}

export function lineColToOffset(sql: string, line: number, column: number): number {
  const lines = sql.split('\n');
  let offset = 0;
  for (let l = 0; l < line - 1 && l < lines.length; l++) offset += lines[l].length + 1;
  return offset + column - 1;
}

export interface ParamOccurrence {
  name: string;
  offset: number;
}

/** Paramètres nommés BigQuery (`@nom`) présents dans la requête. */
export function findParams(sql: string): ParamOccurrence[] {
  const masked = maskSql(sql);
  const out: ParamOccurrence[] = [];
  const re = /(^|[^@\w])@([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    out.push({ name: m[2], offset: m.index + m[1].length });
  }
  return out;
}

/**
 * Paramètres de la requête (PRD F2, simplifié) : `@run_date`, facultatif, est le seul
 * paramètre disponible. Les seuils s'écrivent directement dans le SQL.
 * Contrôle d'ergonomie côté front ; le back refait la vérification.
 */
export function checkParams(sql: string): SqlIssue[] {
  const issues: SqlIssue[] = [];
  const used = findParams(sql);
  const reported = new Set<string>();
  for (const p of used) {
    if (p.name === RUN_DATE_PARAM || reported.has(p.name)) continue;
    reported.add(p.name);
    const { line, column } = offsetToLineCol(sql, p.offset);
    issues.push({
      severity: 'error',
      code: 'PARAM_NOT_ALLOWED',
      message: `@${p.name} : seul @${RUN_DATE_PARAM} est disponible. Écrivez la valeur directement dans la requête (ex. > 500).`,
      line,
      column,
      length: p.name.length + 1,
    });
  }
  return issues;
}

export const usesRunDate = (sql: string) => findParams(sql).some((p) => p.name === RUN_DATE_PARAM);

/** Empreinte stable de la requête, pour lier un test à une version. */
export function queryHash(sql: string): string {
  const s = sql.trim().replace(/\s+/g, ' ');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
