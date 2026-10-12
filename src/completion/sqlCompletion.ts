import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DocumentBindings } from '../editor/bindings';
import { Dialect, resolveDialect } from './dialects';

/** Keywords, types and functions of the dialect of the connection bound to the editor. */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, vscode.CompletionItem[]>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
  ) {}

  private dialectOf(doc: vscode.TextDocument): string | undefined {
    const binding = this.bindings.get(doc);
    return binding ? this.manager.factoryOf(this.manager.config(binding.connectionId)).dialect : undefined;
  }

  provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    // Nothing inside comments or string literals on the current line.
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    if (before.includes('--') || (before.match(/'/g)?.length ?? 0) % 2 === 1) {
      return [];
    }
    const dialect = resolveDialect(this.dialectOf(doc));
    let items = this.cache.get(dialect.id);
    if (!items) {
      items = build(dialect);
      this.cache.set(dialect.id, items);
    }
    // Match the case the user is typing in.
    const word = doc.getText(doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, position));
    const lower = word.length > 0 && word === word.toLowerCase();
    return lower ? items.map((i) => lowerCased(i)) : items;
  }
}

function build(dialect: Dialect): vscode.CompletionItem[] {
  const label = dialect.id === 'ansi' ? 'SQL' : dialect.id;
  const keywords = dialect.keywords.map((k, i) => {
    const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
    item.detail = `${label} keyword`;
    item.sortText = `2${String(i).padStart(4, '0')}`;
    return item;
  });
  const types = dialect.types.map((t) => {
    const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
    item.detail = `${label} type`;
    item.sortText = `3${t}`;
    return item;
  });
  const functions = dialect.functions.map((f) => {
    const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
    item.detail = f.signature;
    item.documentation = f.doc;
    item.sortText = `1${f.name}`;
    if (!f.noParens) {
      item.insertText = new vscode.SnippetString(`${f.name}($0)`);
    }
    return item;
  });
  return [...functions, ...keywords, ...types];
}

function lowerCased(item: vscode.CompletionItem): vscode.CompletionItem {
  const text = typeof item.label === 'string' ? item.label : item.label.label;
  const copy = new vscode.CompletionItem(text.toLowerCase(), item.kind);
  copy.detail = item.detail;
  copy.documentation = item.documentation;
  copy.sortText = item.sortText;
  if (item.insertText instanceof vscode.SnippetString) {
    copy.insertText = new vscode.SnippetString(item.insertText.value.replace(/^[^(]+/, (n) => n.toLowerCase()));
  }
  return copy;
}
