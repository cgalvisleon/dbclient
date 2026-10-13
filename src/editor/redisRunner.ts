import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { QueryHistory, SECRET_REDIS_COMMANDS } from '../store/queryHistory';
import { toCell } from '../webviews/cells';
import { ResultsView } from '../webviews/resultsView';
import { DocumentBindings } from './bindings';
import { CommandLine, commandLines, replyTable } from './redisCommands';

const DANGEROUS = new Set(['FLUSHDB', 'FLUSHALL', 'SHUTDOWN', 'DEBUG', 'SWAPDB']);

/** Runs `.redis` editor lines (one command per line) and shows replies in the results panel. */
export class RedisRunner implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dbclient-redis');

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
    private readonly results: ResultsView,
    private readonly history: QueryHistory,
  ) {}

  private linesFor(editor: vscode.TextEditor, mode: 'auto' | 'file'): CommandLine[] {
    const doc = editor.document;
    if (mode === 'file') {
      return commandLines(doc.getText());
    }
    const selection = editor.selection;
    if (!selection.isEmpty) {
      // Whole lines touched by the selection.
      const range = new vscode.Range(selection.start.line, 0, selection.end.line, doc.lineAt(selection.end.line).text.length);
      return commandLines(doc.getText(range), doc.offsetAt(range.start));
    }
    const line = doc.lineAt(selection.active.line);
    return commandLines(line.text, doc.offsetAt(line.range.start));
  }

  async run(editor: vscode.TextEditor, mode: 'auto' | 'file'): Promise<void> {
    const doc = editor.document;
    const binding = this.bindings.get(doc) ?? (await this.bindings.pick(doc));
    if (!binding) {
      return;
    }
    let lines: CommandLine[];
    try {
      lines = this.linesFor(editor, mode);
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }
    if (!lines.length) {
      vscode.window.showInformationMessage(vscode.l10n.t('There is no command to run.'));
      return;
    }
    const dangerous = lines.filter((l) => DANGEROUS.has(l.args[0]?.toUpperCase()));
    if (dangerous.length) {
      const run = vscode.l10n.t('Run');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('This runs {0}. Continue?', dangerous.map((l) => l.args[0].toUpperCase()).join(', ')),
        { modal: true },
        run,
      );
      if (answer !== run) {
        return;
      }
    }

    const config = this.manager.config(binding.connectionId);
    const db = Number(binding.database ?? config.options.db ?? 0);
    const pageSize = vscode.workspace.getConfiguration('dbclient').get<number>('pageSize', 100);
    this.diagnostics.delete(doc.uri);
    await this.results.reveal();
    this.results.post({ type: 'run', title: config.name, pageSize });

    let failed = false;
    try {
      const driver = await this.manager.connectKv(binding.connectionId);
      for (const line of lines) {
        const pos = doc.positionAt(line.start);
        const location = { uri: doc.uri.toString(), line: pos.line, character: pos.character };
        const started = Date.now();
        const record = (ok: boolean, extra: { rows?: number; error?: string }) => {
          if (!SECRET_REDIS_COMMANDS.has(line.args[0]?.toUpperCase())) {
            this.history.add({
              time: new Date(started).toISOString(),
              connectionId: binding.connectionId,
              database: String(db),
              language: 'redis',
              text: line.text,
              ok,
              durationMs: Date.now() - started,
              ...extra,
            });
          }
        };
        try {
          const reply = await driver.command(db, line.args);
          const durationMs = Date.now() - started;
          record(true, { rows: Array.isArray(reply) ? reply.length : undefined });
          const table = replyTable(line.args, reply);
          this.results.post({
            type: 'result',
            tab: {
              title: line.text.length > 40 ? `${line.text.slice(0, 39)}…` : line.text,
              sql: line.text,
              command: line.args[0].toUpperCase(),
              columns: table.columns.map((name) => ({ name })),
              rows: table.rows.map((r) => r.map(toCell)),
              rowCount: table.rows.length,
              truncated: false,
              durationMs,
            },
          });
          const summary = Array.isArray(reply) ? vscode.l10n.t('{0} items', reply.length) : reply === null ? '(nil)' : String(reply).split('\n')[0].slice(0, 120);
          this.log(config.name, line.text, true, summary, location, durationMs);
        } catch (err) {
          failed = true;
          record(false, { error: (err as Error).message });
          this.log(config.name, line.text, false, (err as Error).message, location);
          this.diagnostics.set(doc.uri, [
            new vscode.Diagnostic(new vscode.Range(pos, doc.positionAt(line.end)), (err as Error).message, vscode.DiagnosticSeverity.Error),
          ]);
          break;
        }
      }
    } catch (err) {
      failed = true;
      this.log(config.name, lines[0].text, false, (err as Error).message);
    }
    if (failed) {
      this.results.post({ type: 'focusLog' });
    }
  }

  private log(connection: string, text: string, ok: boolean, message: string, location?: { uri: string; line: number; character: number }, durationMs?: number): void {
    this.results.post({
      type: 'log',
      entry: { time: new Date().toLocaleTimeString(), connection, sql: text, ok, message, durationMs, location },
    });
  }

  dispose(): void {
    this.diagnostics.dispose();
  }
}
