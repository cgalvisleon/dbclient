// CodeMirror 6 for the DB Client SQL editor webview, bundled by esbuild.mjs into
// media/vendor/codemirror.js (an IIFE that sets window.DbCodeMirror).
//
// No history extension: undo/redo belong to the VS Code text document behind the custom editor,
// so the webview gets them back as ordinary document changes.
import { autocompletion, pickedCompletion } from '@codemirror/autocomplete';
import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, mssql: MSSQL, oracle: PLSQL, sqlite: SQLite };
const language = new Compartment();
const sqlFor = (dialect) => sql({ dialect: DIALECTS[dialect] ?? StandardSQL, upperCaseKeywords: true });

/** Codicon glyph and symbolIcon color of each completion `type` the extension sends. */
const ICONS = {
  keyword: ['\\eb62', 'keyword'],
  function: ['\\ea8c', 'function'],
  type: ['\\ea92', 'typeParameter'],
  class: ['\\eb5b', 'class'],
  interface: ['\\eb61', 'interface'],
  property: ['\\eb5f', 'field'],
  namespace: ['\\ea8b', 'namespace'],
  text: ['\\ea93', 'text'],
};

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
  // The completion list, styled like VS Code's suggest widget.
  '.cm-tooltip': {
    color: 'var(--vscode-editorSuggestWidget-foreground, var(--vscode-editor-foreground))',
    backgroundColor: 'var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background)) !important',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-editorWidget-border, transparent)) !important',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--vscode-editor-font-family)', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '1px 6px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground)) !important',
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)) !important',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'bold', color: 'var(--vscode-editorSuggestWidget-highlightForeground, inherit)' },
  '.cm-completionDetail': { fontStyle: 'normal', marginLeft: '1em', color: 'var(--vscode-descriptionForeground)' },
  '.cm-completionInfo': { padding: '4px 8px', whiteSpace: 'pre-wrap' },
  '.cm-completionIcon': { fontFamily: 'codicon', fontSize: '14px', width: '1.2em', paddingRight: '0.4em', opacity: '1', verticalAlign: 'middle' },
  ...Object.fromEntries(
    Object.entries(ICONS).map(([type, [glyph, color]]) => [`.cm-completionIcon-${type}:after`, { content: `'${glyph}'`, color: `var(--vscode-symbolIcon-${color}Foreground)` }]),
  ),
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
 * Completion source backed by the extension (the same provider as the text editor). Opens like
 * VS Code's: on a word, after `.` or a space, or with Ctrl+Space; while the same word is typed,
 * CodeMirror filters the list it has without asking again.
 * @param {(pos: number, explicit: boolean) => Promise<any[] | null>} complete
 */
function completionSource(complete) {
  return async (context) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]+$/u);
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    if (!context.explicit && !word && before !== '.' && before !== ' ') return null;
    const items = await complete(context.pos, context.explicit);
    if (context.aborted || !items || !items.length) return null;
    return { from: word ? word.from : context.pos, options: items.map(toCompletion), validFor: /^[\p{L}\p{N}_$]*$/u };
  };
}

/** `{label, displayLabel, detail, info, type, boost, apply, cursor}` → CodeMirror completion; `cursor` places the caret inside `apply`. */
function toCompletion(item) {
  const completion = { label: item.label, displayLabel: item.displayLabel, detail: item.detail, info: item.info, type: item.type, boost: item.boost };
  if (item.apply !== undefined && item.cursor === undefined) completion.apply = item.apply;
  else if (item.apply !== undefined) {
    completion.apply = (view, c, from, to) =>
      view.dispatch({
        changes: { from, to, insert: item.apply },
        selection: { anchor: from + item.cursor },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(c),
      });
  }
  return completion;
}

/**
 * Creates the editor in `parent`.
 * @param {{ parent: HTMLElement, doc: string, dialect?: string, nonce?: string, placeholder?: string,
 *   keys?: { key: string, run: () => boolean }[], onChange?: (update: import('@codemirror/view').ViewUpdate) => void,
 *   complete?: (pos: number, explicit: boolean) => Promise<any[] | null> }} options
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
  if (options.complete) extensions.push(autocompletion({ override: [completionSource(options.complete)], icons: true }));
  if (options.nonce) extensions.push(EditorView.cspNonce.of(options.nonce));
  if (options.placeholder) extensions.push(placeholder(options.placeholder));
  return new EditorView({ parent: options.parent, state: EditorState.create({ doc: options.doc, extensions }) });
}

/** Switches the SQL dialect (keywords, quoting) when the editor's connection changes. */
function setDialect(view, dialect) {
  view.dispatch({ effects: language.reconfigure(sqlFor(dialect)) });
}

window.DbCodeMirror = { create, setDialect, EditorSelection };
