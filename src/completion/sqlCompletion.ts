import * as vscode from 'vscode';
import { CatalogCache } from '../connections/catalog';
import { ConnectionManager } from '../connections/manager';
import { Catalog, CatalogTable, TableInfo } from '../drivers/types';
import { Binding, DocumentBindings } from '../editor/bindings';
import { splitStatements } from '../editor/statements';
import { quoteIdent } from '../sql/identifiers';
import { completionContext, TableReference, tableReferences } from '../sql/parse';
import { Dialect, resolveDialect } from './dialects';

/**
 * Keywords, types and functions of the connection's dialect, plus — while the connection is
 * open — its real schemas, tables, views and columns: tables after FROM/JOIN/UPDATE/INTO,
 * columns of the statement's tables elsewhere, and `alias.` / `table.` / `schema.` members.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, vscode.CompletionItem[]>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
    private readonly catalog: CatalogCache,
  ) {}

  private dialectOf(binding: Binding | undefined): string | undefined {
    return binding ? this.manager.factoryOf(this.manager.config(binding.connectionId)).dialect : undefined;
  }

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
    // Nothing inside comments or string literals on the current line.
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    if (before.includes('--') || (before.match(/'/g)?.length ?? 0) % 2 === 1) {
      return [];
    }
    const binding = this.bindings.get(doc);
    const dialect = resolveDialect(this.dialectOf(binding));
    const keywords = this.keywords(doc, position, dialect);
    if (!binding || !this.manager.isConnected(binding.connectionId)) {
      return keywords;
    }
    try {
      return await this.objects(doc, position, binding, dialect.id, keywords);
    } catch {
      return keywords;
    }
  }

  private keywords(doc: vscode.TextDocument, position: vscode.Position, dialect: Dialect): vscode.CompletionItem[] {
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

  private async objects(
    doc: vscode.TextDocument,
    position: vscode.Position,
    binding: Binding,
    dialect: string,
    keywords: vscode.CompletionItem[],
  ): Promise<vscode.CompletionItem[]> {
    const offset = doc.offsetAt(position);
    // The statement the caret is in or right after (trailing spaces included), unless already terminated.
    const all = doc.getText();
    const last = splitStatements(all, dialect).filter((s) => s.start <= offset).pop();
    const terminated = last && all.slice(last.end, last.terminatorEnd).trim() !== '' && offset >= last.terminatorEnd;
    const statement = last && !terminated ? last : undefined;
    const text = statement ? all.slice(statement.start, Math.max(statement.end, offset)) : '';
    const local = statement ? offset - statement.start : 0;
    const context = completionContext(text, local);
    const refs = tableReferences(text);
    const { connectionId, database } = binding;
    const catalog = await this.catalog.catalog(connectionId, database);

    if (context.kind === 'member') {
      const qualifier = context.qualifier[context.qualifier.length - 1];
      const schemaPart = context.qualifier.length > 1 ? context.qualifier[context.qualifier.length - 2] : undefined;
      const ref = refs.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase()) ?? refs.find((r) => !r.alias && r.name.toLowerCase() === qualifier.toLowerCase());
      const table = ref
        ? await this.catalog.resolve(connectionId, database, ref.schema, ref.name, ref.quoted)
        : await this.catalog.resolve(connectionId, database, schemaPart, qualifier);
      if (table) {
        const info = await this.catalog.describe(connectionId, { database, schema: table.schema, name: table.name });
        return info ? info.columns.map((c, i) => columnItem(c.name, c.type, `${qualifier}.${c.name}`, info, dialect, i)) : [];
      }
      // `schema.` lists that schema's tables.
      const inSchema = catalog.tables.filter((t) => t.schema?.toLowerCase() === qualifier.toLowerCase());
      return inSchema.map((t) => tableItem(t, catalog, dialect, false));
    }

    if (context.kind === 'table') {
      const schemas = [...new Set(catalog.tables.map((t) => t.schema).filter((s): s is string => Boolean(s)))];
      const schemaItems = schemas.length > 1 || (schemas.length === 1 && schemas[0] !== catalog.defaultSchema)
        ? schemas.map((s) => {
            const item = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
            item.detail = 'schema';
            item.insertText = quoteIdent(s, dialect);
            item.sortText = `1${s}`;
            return item;
          })
        : [];
      return [...catalog.tables.map((t) => tableItem(t, catalog, dialect, true)), ...schemaItems, ...keywords];
    }

    // Columns of every table the statement uses; names shared by several get qualified.
    const described = await this.describeAll(connectionId, database, refs);
    const counts = new Map<string, number>();
    described.forEach(({ info }) => info.columns.forEach((c) => counts.set(c.name.toLowerCase(), (counts.get(c.name.toLowerCase()) ?? 0) + 1)));
    const columns = described.flatMap(({ ref, info }) =>
      info.columns.map((c, i) => {
        const owner = ref.alias ?? ref.name;
        const item = columnItem(c.name, c.type, `${owner}.${c.name}`, info, dialect, i);
        if ((counts.get(c.name.toLowerCase()) ?? 0) > 1) {
          item.label = `${owner}.${c.name}`;
          item.insertText = `${quoteIdent(owner, dialect)}.${quoteIdent(c.name, dialect)}`;
          item.filterText = `${c.name} ${owner}.${c.name}`;
        }
        return item;
      }),
    );
    return [...columns, ...keywords];
  }

  private async describeAll(connectionId: string, database: string | undefined, refs: TableReference[]): Promise<{ ref: TableReference; info: TableInfo }[]> {
    const found = await Promise.all(
      refs.slice(0, 20).map(async (ref) => {
        const table = await this.catalog.resolve(connectionId, database, ref.schema, ref.name, ref.quoted);
        const info = table && (await this.catalog.describe(connectionId, { database, schema: table.schema, name: table.name }));
        return info ? { ref, info } : undefined;
      }),
    );
    return found.filter((f): f is { ref: TableReference; info: TableInfo } => Boolean(f));
  }
}

function tableItem(table: CatalogTable, catalog: Catalog, dialect: string, qualify: boolean): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    { label: table.name, description: table.schema },
    table.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class,
  );
  item.detail = table.schema ? `${table.kind} · ${table.schema}` : table.kind;
  const name = quoteIdent(table.name, dialect);
  // Outside the default schema the name only resolves qualified.
  item.insertText = qualify && table.schema && table.schema !== catalog.defaultSchema ? `${quoteIdent(table.schema, dialect)}.${name}` : name;
  item.filterText = table.name;
  item.sortText = `0${table.schema === catalog.defaultSchema ? '0' : '1'}${table.name}`;
  return item;
}

function columnItem(name: string, type: string, detail: string, info: TableInfo, dialect: string, index: number): vscode.CompletionItem {
  const item = new vscode.CompletionItem({ label: name, description: type }, vscode.CompletionItemKind.Field);
  item.detail = `${detail} · ${type}${info.primaryKey.includes(name) ? ' · PK' : ''}`;
  item.insertText = quoteIdent(name, dialect);
  item.filterText = name;
  item.sortText = `0${String(index).padStart(4, '0')}`;
  return item;
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
