import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { SqlIssue } from '../api/types';
import { lineColToOffset } from '../lib/sql';

/** Dialecte GoogleSQL (BigQuery) : identifiants entre backticks, mots-clés spécifiques. */
const GoogleSQL = SQLDialect.define({
  keywords:
    'select from where and or not in is null as join left right inner full outer cross on using group by order having limit offset ' +
    'with distinct all union intersect except case when then else end between like exists qualify window over partition rows range ' +
    'unnest struct array interval true false asc desc nulls first last safe_cast cast if ifnull coalesce extract date timestamp datetime ' +
    'insert update delete merge create drop truncate alter',
  types: 'string int64 float64 numeric bignumeric bool bytes date datetime time timestamp geography json array struct interval',
  builtin:
    'count sum avg min max countif array_agg string_agg date_sub date_add date_diff date_trunc timestamp_diff timestamp_sub timestamp_add ' +
    'current_date current_timestamp format_date parse_date lower upper trim regexp_contains regexp_extract split concat length round ' +
    'safe_divide row_number rank dense_rank lag lead',
  identifierQuotes: '`',
  hashComments: true,
  specialVar: '@',
});

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-3)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent-soft) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border-strong)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
});

export interface SqlEditorHandle {
  goTo(line: number, column?: number): void;
}

interface Props {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  issues?: SqlIssue[];
  id?: string;
  ariaLabel?: string;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { value, onChange, readOnly, issues, id, ariaLabel },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const ro = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          sql({ dialect: GoogleSQL, upperCaseKeywords: true }),
          theme,
          ro.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Requête SQL', ...(id ? { id } : {}) }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Valeur pilotée de l'extérieur (restauration de brouillon, changement de version…)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: ro.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  // Erreurs du dry-run surlignées dans l'éditeur (PRD F3).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    const diags: Diagnostic[] = (issues ?? [])
      .filter((i) => i.line)
      .map((i) => {
        const from = Math.max(0, Math.min(doc.length, lineColToOffset(doc, i.line!, i.column ?? 1)));
        const to = Math.min(doc.length, from + Math.max(1, i.length ?? 1));
        return { from, to, severity: i.severity, message: i.message };
      });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [issues]);

  useImperativeHandle(ref, () => ({
    goTo(line, column = 1) {
      const v = view.current;
      if (!v) return;
      const doc = v.state.doc.toString();
      const pos = Math.max(0, Math.min(doc.length, lineColToOffset(doc, line, column)));
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      v.focus();
    },
  }));

  return <div className={`sql-editor${readOnly ? ' readonly' : ''}`} ref={host} />;
});
