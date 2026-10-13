import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { StatementError } from '../drivers/types';
import { CatalogCache } from '../connections/catalog';
import { QueryHistory } from '../store/queryHistory';
import { toCell } from '../webviews/cells';
import { LogEntry, ResultsView } from '../webviews/resultsView';
import { DocumentBindings } from './bindings';
import { GridEditor } from './gridEditor';
import { splitStatements, Statement, statementAt } from './statements';

export type RunMode = 'auto' | 'file' | { offset: number };

interface Running {
  cancelled: boolean;
  cancel(): Promise<void>;
}

/** Executes statements of a SQL editor and feeds the results panel, output log and diagnostics. */
export class SqlRunner implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dbclient');
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
    private readonly results: ResultsView,
    private readonly history: QueryHistory,
    private readonly catalog: CatalogCache,
  ) {
    this.grid = new GridEditor(manager, catalog, results);
  }

  private readonly grid: GridEditor;

  /** Statements to run: the selection, the one under the caret, the one at `offset`, or the whole file. */
  private statementsFor(editor: vscode.TextEditor, mode: RunMode, dialect: string | undefined): Statement[] {
    const doc = editor.document;
    if (mode === 'file') {
      return splitStatements(doc.getText(), dialect);
    }
    if (typeof mode === 'object') {
      const stmt = statementAt(splitStatements(doc.getText(), dialect), mode.offset);
      return stmt ? [stmt] : [];
    }
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const base = doc.offsetAt(selection.start);
      return splitStatements(doc.getText(selection), dialect).map((s) => ({
        ...s,
        start: s.start + base,
        end: s.end + base,
        terminatorEnd: s.terminatorEnd + base,
      }));
    }
    const stmt = statementAt(splitStatements(doc.getText(), dialect), doc.offsetAt(selection.active));
    return stmt ? [stmt] : [];
  }

  async run(editor: vscode.TextEditor | undefined, mode: RunMode): Promise<void> {
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a SQL editor to run statements.'));
      return;
    }
    const doc = editor.document;
    const key = doc.uri.toString();
    if (this.running.has(key)) {
      vscode.window.showWarningMessage(vscode.l10n.t('A query is already running in this editor.'));
      return;
    }
    const binding = this.bindings.get(doc) ?? (await this.bindings.pick(doc));
    if (!binding) {
      return;
    }
    const config = this.manager.config(binding.connectionId);
    const statements = this.statementsFor(editor, mode, this.manager.factoryOf(config).dialect);
    if (!statements.length) {
      vscode.window.showInformationMessage(vscode.l10n.t('There is no statement to run.'));
      return;
    }

    const maxRows = vscode.workspace.getConfiguration('dbclient').get<number>('maxRows', 5000);
    const pageSize = vscode.workspace.getConfiguration('dbclient').get<number>('pageSize', 100);
    this.diagnostics.delete(doc.uri);
    await this.results.reveal();
    this.results.post({ type: 'run', title: config.name, pageSize });

    const state: Running = { cancelled: false, cancel: async () => undefined };
    this.running.set(key, state);
    let failed = false;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Running on {0}', config.name),
          cancellable: true,
        },
        async (progress, token) => {
          const driver = await this.manager.connectSql(binding.connectionId);
          state.cancel = async () => {
            state.cancelled = true;
            await driver.cancel(binding.database);
          };
          token.onCancellationRequested(() => void state.cancel());

          for (const [i, stmt] of statements.entries()) {
            if (state.cancelled) {
              break;
            }
            if (statements.length > 1) {
              progress.report({ message: `${i + 1}/${statements.length}`, increment: 100 / statements.length });
            }
            const location = this.locate(doc, stmt.start);
            const started = Date.now();
            const record = (ok: boolean, extra: { rows?: number; error?: string }) =>
              this.history.add({
                time: new Date(started).toISOString(),
                connectionId: binding.connectionId,
                database: binding.database,
                language: 'sql',
                text: stmt.text,
                ok,
                durationMs: Date.now() - started,
                ...extra,
              });
            try {
              const results = await driver.execute(stmt.text, { database: binding.database, maxRows });
              const counted = results.filter((r) => r.rowCount !== null && r.rowCount !== undefined);
              record(true, { rows: counted.length ? counted.reduce((n, r) => n + (r.rowCount ?? 0), 0) : undefined });
              if (/^\s*(create|alter|drop|rename|truncate|comment)\b/i.test(stmt.text)) {
                // Tables or columns may have changed: completion and grid editing re-read them.
                this.catalog.invalidate(binding.connectionId);
              }
              const sets = results.filter((r) => r.columns.length);
              for (const result of results) {
                if (result.columns.length) {
                  const editing = sets.length === 1 ? await this.grid.prepare(binding, driver.dialect, stmt.text, result) : {};
                  this.results.post({
                    type: 'result',
                    tab: {
                      ...result,
                      title: preview(stmt.text, 40),
                      rows: result.rows.map((r) => r.map(toCell)),
                      ...editing,
                    },
                  });
                }
                this.log(config.name, stmt.text, true, describe(result.command, result.rowCount, result.columns.length > 0, result.truncated), location, result.durationMs);
              }
            } catch (err) {
              failed = true;
              record(false, { error: (err as Error).message });
              const at = errorOffset(stmt, err);
              this.log(config.name, stmt.text, false, (err as Error).message, at === undefined ? location : this.locate(doc, at.offset));
              this.diagnostics.set(doc.uri, [
                new vscode.Diagnostic(
                  this.errorRange(doc, stmt, at),
                  (err as Error).message,
                  vscode.DiagnosticSeverity.Error,
                ),
              ]);
              // Stop at the first error, like NetBeans' default.
              break;
            }
          }
        },
      );
    } catch (err) {
      failed = true;
      this.log(config.name, preview(statements[0].text, 200), false, (err as Error).message);
    } finally {
      this.running.delete(key);
    }
    if (failed) {
      this.results.post({ type: 'focusLog' });
    }
  }

  async cancel(editor: vscode.TextEditor | undefined): Promise<void> {
    const running = editor ? this.running.get(editor.document.uri.toString()) : [...this.running.values()][0];
    if (!running) {
      vscode.window.setStatusBarMessage(vscode.l10n.t('No query is running.'), 2000);
      return;
    }
    await running.cancel();
  }

  private locate(doc: vscode.TextDocument, offset: number): LogEntry['location'] {
    const pos = doc.positionAt(offset);
    return { uri: doc.uri.toString(), line: pos.line, character: pos.character };
  }

  private errorRange(doc: vscode.TextDocument, stmt: Statement, at: ReturnType<typeof errorOffset>): vscode.Range {
    if (!at) {
      return new vscode.Range(doc.positionAt(stmt.start), doc.positionAt(stmt.end));
    }
    const position = doc.positionAt(at.offset);
    if (at.wholeLine) {
      // Underline the statement's part of that line.
      const line = doc.lineAt(position.line).range;
      const end = doc.positionAt(Math.min(stmt.end, doc.offsetAt(line.end)));
      return new vscode.Range(position, end.isAfter(position) ? end : line.end);
    }
    return doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, doc.positionAt(at.offset + 1));
  }

  private log(connection: string, sql: string, ok: boolean, message: string, loc?: LogEntry['location'], durationMs?: number): void {
    const where = loc ? ` [${vscode.l10n.t('line {0}, column {1}', loc.line + 1, loc.character + 1)}]` : '';
    this.results.post({
      type: 'log',
      entry: {
        time: new Date().toLocaleTimeString(),
        connection,
        sql: preview(sql, 200),
        ok,
        message: ok ? message : `${message}${where}`,
        durationMs,
        location: loc,
      },
    });
  }

  dispose(): void {
    this.diagnostics.dispose();
  }
}

/** Document offset of the error: the engine's 1-based character position, or the start of its 1-based line, inside the statement. */
function errorOffset(stmt: Statement, err: unknown): { offset: number; wholeLine: boolean } | undefined {
  if (!(err instanceof StatementError)) {
    return undefined;
  }
  if (err.position && err.position > 0) {
    return { offset: stmt.start + Math.min(err.position - 1, stmt.text.length), wholeLine: false };
  }
  if (err.line && err.line > 0) {
    const lines = stmt.text.split('\n');
    if (err.line <= lines.length) {
      const before = lines.slice(0, err.line - 1).reduce((n, l) => n + l.length + 1, 0);
      const indent = lines[err.line - 1].length - lines[err.line - 1].trimStart().length;
      return { offset: stmt.start + before + indent, wholeLine: true };
    }
  }
  return undefined;
}

function preview(sql: string, length: number): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function describe(command: string | undefined, rowCount: number | null, isQuery: boolean, truncated: boolean): string {
  if (isQuery) {
    return truncated
      ? vscode.l10n.t('Fetched the first rows (result truncated by dbclient.maxRows)')
      : vscode.l10n.t('{0} rows fetched', rowCount ?? 0);
  }
  if (rowCount !== null && command === 'DML') {
    return vscode.l10n.t('{0} rows affected', rowCount);
  }
  if (rowCount !== null && command && /^(INSERT|UPDATE|DELETE|MERGE|COPY|MOVE|FETCH|REPLACE)$/.test(command)) {
    return vscode.l10n.t('{0}: {1} rows affected', command, rowCount);
  }
  return vscode.l10n.t('{0} executed successfully', command ?? 'Statement');
}
