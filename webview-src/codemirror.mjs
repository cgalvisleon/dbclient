// CodeMirror 6 for the DB Client SQL editor webview, bundled by esbuild.mjs into
// media/vendor/codemirror.js (an IIFE that sets window.DbCodeMirror).
//
// No history extension: undo/redo belong to the VS Code text document behind the custom editor,
// so the webview gets them back as ordinary document changes.
import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, mssql: MSSQL, oracle: PLSQL, sqlite: SQLite };
const language = new Compartment();
const sqlFor = (dialect) => sql({ dialect: DIALECTS[dialect] ?? StandardSQL, upperCaseKeywords: true });

// Colors come from the VS Code theme variables the webview receives.
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--vscode-editor-foreground)',
    backgroundColor: 'var(--vscode-editor-background)',
    fontSize: 'var(--vscode-editor-font-size)',
  },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-gutters': {
    color: 'var(--vscode-editorLineNumber-foreground)',
    backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
    border: 'none',
  },
  '.cm-activeLineGutter': { color: 'var(--vscode-editorLineNumber-activeForeground)', backgroundColor: 'transparent' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
  '.cm-placeholder': { color: 'var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground))' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--vscode-symbolIcon-keywordForeground, #569cd6)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--vscode-descriptionForeground, #6a9955)', fontStyle: 'italic' },
  { tag: [tags.special(tags.name), tags.variableName], color: 'var(--vscode-debugTokenExpression-name, inherit)' },
]);

/**
 * Creates the editor in `parent`.
 * @param {{ parent: HTMLElement, doc: string, dialect?: string, nonce?: string, placeholder?: string,
 *   keys?: { key: string, run: () => boolean }[], onChange?: (update: import('@codemirror/view').ViewUpdate) => void }} options
 */
function create(options) {
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(highlight),
    language.of(sqlFor(options.dialect)),
    keymap.of([...(options.keys ?? []), ...defaultKeymap, indentWithTab]),
    theme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => update.docChanged && options.onChange?.(update)),
  ];
  if (options.nonce) extensions.push(EditorView.cspNonce.of(options.nonce));
  if (options.placeholder) extensions.push(placeholder(options.placeholder));
  return new EditorView({ parent: options.parent, state: EditorState.create({ doc: options.doc, extensions }) });
}

/** Switches the SQL dialect (keywords, quoting) when the editor's connection changes. */
function setDialect(view, dialect) {
  view.dispatch({ effects: language.reconfigure(sqlFor(dialect)) });
}

window.DbCodeMirror = { create, setDialect, EditorSelection };
