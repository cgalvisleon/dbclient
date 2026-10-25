import * as vscode from 'vscode';

/** A completion item as the DB Client SQL editor's CodeMirror takes it (`webview-src/codemirror.mjs`). */
export interface WebviewCompletion {
  /** What CodeMirror matches the typed word against (the item's `filterText`, else its label). */
  label: string;
  /** Shown instead of `label` when they differ. */
  displayLabel?: string;
  detail?: string;
  info?: string;
  type: string;
  /** −99…99: the order of VS Code's `sortText` among items that match equally well. */
  boost: number;
  /** Text inserted in place of the typed word; `cursor` puts the caret at that index of it. */
  apply?: string;
  cursor?: number;
}

const TYPES = new Map<vscode.CompletionItemKind, string>([
  [vscode.CompletionItemKind.Keyword, 'keyword'],
  [vscode.CompletionItemKind.Function, 'function'],
  [vscode.CompletionItemKind.Method, 'function'],
  [vscode.CompletionItemKind.TypeParameter, 'type'],
  [vscode.CompletionItemKind.Class, 'class'],
  [vscode.CompletionItemKind.Interface, 'interface'],
  [vscode.CompletionItemKind.Field, 'property'],
  [vscode.CompletionItemKind.Property, 'property'],
  [vscode.CompletionItemKind.Module, 'namespace'],
]);

/** Turns the items of a VS Code completion provider into what the SQL editor webview shows. */
export function toWebviewCompletions(result: vscode.CompletionItem[] | vscode.CompletionList | null | undefined): WebviewCompletion[] {
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  const labelOf = (i: vscode.CompletionItem) => (typeof i.label === 'string' ? i.label : i.label.label);
  const sorted = [...items].sort((a, b) => (a.sortText ?? labelOf(a)).localeCompare(b.sortText ?? labelOf(b)));
  const last = Math.max(1, sorted.length - 1);
  return sorted.map((item, rank) => {
    const label = labelOf(item);
    const description = typeof item.label === 'string' ? undefined : item.label.description;
    const documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
    const out: WebviewCompletion = {
      label: item.filterText ?? label,
      type: TYPES.get(item.kind ?? vscode.CompletionItemKind.Text) ?? 'text',
      boost: Math.round(99 - (198 * rank) / last),
    };
    if (out.label !== label) {
      out.displayLabel = label;
    }
    const detail = description ?? item.detail;
    if (detail) {
      out.detail = detail;
    }
    const info = [description ? item.detail : undefined, documentation].filter(Boolean).join('\n\n');
    if (info) {
      out.info = info;
    }
    if (item.insertText instanceof vscode.SnippetString) {
      Object.assign(out, fromSnippet(item.insertText.value));
    } else if (item.insertText !== undefined && item.insertText !== out.label) {
      out.apply = item.insertText;
    } else if (out.label !== label) {
      out.apply = label;
    }
    return out;
  });
}

/** Snippet text → plain text, with the caret where VS Code puts it first (`$1`, else `$0`, else the end); placeholders keep their default text. */
export function fromSnippet(snippet: string): { apply: string; cursor: number } {
  let apply = '';
  const stops = new Map<string, number>();
  const pattern = /\\([$}\\])|\$\{(\d+)(?::([^}]*))?\}|\$(\d+)/g;
  let at = 0;
  for (let m = pattern.exec(snippet); m; m = pattern.exec(snippet)) {
    apply += snippet.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      apply += m[1];
      continue;
    }
    const tabstop = m[2] ?? m[4];
    if (!stops.has(tabstop)) {
      stops.set(tabstop, apply.length);
    }
    apply += m[3] ?? '';
  }
  apply += snippet.slice(at);
  return { apply, cursor: stops.get('1') ?? stops.get('0') ?? apply.length };
}
