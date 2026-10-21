import * as vscode from 'vscode';
import type { ParamValue } from '../drivers/types';
import type { GridEdit, GridRowChange } from '../editor/gridEditor';
import type { RowSqlKind } from '../sql/generate';
import { buildXlsx, XlsxCell } from '../export/xlsx';
import { mediaRoots, webviewHtml } from './html';
import { t } from '../l10n';

export const RESULTS_VIEW_ID = 'dbclient.results';

export interface ResultTab {
  title: string;
  sql: string;
  command?: string;
  columns: { name: string; type?: string }[];
  rows: (string | number | boolean | null)[][];
  rowCount: number | null;
  truncated: boolean;
  durationMs: number;
  /** Present when the grid can edit these rows. */
  edit?: GridEdit;
  /** Why a single-table result is not editable. */
  readOnly?: string;
  /** Present when its rows can be turned into INSERT/UPDATE/DELETE (columns map onto one table). */
  source?: number;
}

/** Actions of the grid's context menu (`dbclient.results.*` commands). */
export type RowAction = 'copyValue' | 'copyRow' | 'copyRowJson' | RowSqlKind;

export interface LogEntry {
  time: string;
  connection: string;
  sql: string;
  ok: boolean;
  message: string;
  durationMs?: number;
  /** Where to jump when the entry is clicked (0-based). */
  location?: { uri: string; line: number; character: number };
}

export type ToView =
  | { type: 'run'; title: string; pageSize: number }
  | { type: 'result'; tab: ResultTab }
  | { type: 'log'; entry: LogEntry }
  | { type: 'focusLog' }
  /** Activates a result tab; negative counts from the end. */
  | { type: 'select'; tab: number }
  /** A context menu action on the cell `row`/`col` of the tab numbered `seq`. */
  | { type: 'rowAction'; action: RowAction; seq: number; row: number; col: number }
  | {
      type: 'committed';
      editId: number;
      ok: boolean;
      message?: string;
      /** Rows re-read after saving; absent when the query could not be re-run. */
      rows?: ParamValue[][];
      rowCount?: number | null;
      truncated?: boolean;
    };

export type FromView =
  | { type: 'ready' }
  | { type: 'copy'; text: string }
  | { type: 'save'; format: 'csv' | 'json'; content: string; name: string }
  | { type: 'saveXlsx'; name: string; sheet: string; columns: string[]; types: (string | undefined)[]; rows: XlsxCell[][] }
  | { type: 'reveal'; location: NonNullable<LogEntry['location']> }
  | { type: 'commit'; editId: number; changes: GridRowChange[] }
  | { type: 'rowSql'; source: number; kind: RowSqlKind; row: ParamValue[] };

/** Where a run sends its results: the bottom panel or a DB Client SQL editor. */
export interface ResultsSink {
  post(message: ToView): void;
  /** Shows the results without taking focus from the editor; resolves once they receive messages. */
  reveal(): Promise<void>;
  /** Puts the caret on a log entry's location (SQL editors only). */
  goto?(line: number, character: number): void;
}

const RESULT_MESSAGES = new Set(['ready', 'copy', 'save', 'saveXlsx', 'reveal', 'commit', 'rowSql']);

/**
 * One webview running media/results.js: queues messages until it is ready and answers what the
 * grid asks for (copy, export, commit, row SQL, jump to a log entry).
 */
export class ResultsChannel implements ResultsSink {
  private webview?: vscode.Webview;
  private ready = false;
  private queue: ToView[] = [];
  private readyWaiters: (() => void)[] = [];

  constructor(
    private readonly hub: ResultsView,
    private readonly show: () => Promise<void>,
    readonly goto?: (line: number, character: number) => void,
  ) {}

  /** Starts talking to `webview` (a new or reloaded page waits for its `ready`). */
  attach(webview: vscode.Webview): void {
    this.webview = webview;
    this.ready = false;
  }

  detach(): void {
    this.webview = undefined;
    this.ready = false;
  }

  async reveal(): Promise<void> {
    await this.show();
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        this.readyWaiters.push(resolve);
        setTimeout(resolve, 5000);
      });
    }
  }

  post(message: ToView): void {
    if (this.webview && this.ready) {
      void this.webview.postMessage(message);
    } else {
      this.queue.push(message);
    }
  }

  /** Handles a message of the results UI; false when it is not one (a SQL editor's own message). */
  async handle(message: { type: string }): Promise<boolean> {
    if (!RESULT_MESSAGES.has(message.type)) {
      return false;
    }
    if (message.type === 'ready') {
      this.ready = true;
      const queued = this.queue;
      this.queue = [];
      queued.forEach((m) => this.post(m));
      this.readyWaiters.splice(0).forEach((resolve) => resolve());
      return true;
    }
    await this.hub.answer(this, message as FromView);
    return true;
  }
}

/**
 * Bottom-panel view with one tab per result set plus the SQL output log. It also routes results:
 * a document open in a DB Client SQL editor gets them in that editor (see `register`).
 */
export class ResultsView implements vscode.WebviewViewProvider, ResultsSink {
  private view?: vscode.WebviewView;
  private readonly panel = new ResultsChannel(this, () => this.showPanel());
  private readonly sinks = new Map<string, ResultsSink>();
  private commitHandler?: (sink: ResultsSink, editId: number, changes: GridRowChange[]) => Promise<void>;
  private rowSqlHandler?: (source: number, kind: RowSqlKind, row: ParamValue[]) => Promise<void>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: mediaRoots(this.extensionUri) };
    this.panel.attach(view.webview);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'results', 'Results');
    view.webview.onDidReceiveMessage((m: FromView) => this.panel.handle(m));
    view.onDidDispose(() => {
      this.view = undefined;
      this.panel.detach();
    });
  }

  /** Handles "Commit" from an editable grid; answer on `sink`. */
  onCommit(handler: (sink: ResultsSink, editId: number, changes: GridRowChange[]) => Promise<void>): void {
    this.commitHandler = handler;
  }

  /** Handles "Generate INSERT/UPDATE/DELETE" from a row's context menu. */
  onRowSql(handler: (source: number, kind: RowSqlKind, row: ParamValue[]) => Promise<void>): void {
    this.rowSqlHandler = handler;
  }

  /** Sends the results of `uri` to `sink` (a DB Client SQL editor) while it is open. */
  register(uri: vscode.Uri, sink: ResultsSink): vscode.Disposable {
    const key = uri.toString();
    this.sinks.set(key, sink);
    return new vscode.Disposable(() => this.sinks.get(key) === sink && this.sinks.delete(key));
  }

  /** The results of `doc`: its SQL editor's own, or the bottom panel. */
  for(doc: vscode.TextDocument | vscode.Uri | string | undefined): ResultsSink {
    const key = typeof doc === 'string' ? doc : doc instanceof vscode.Uri ? doc.toString() : doc?.uri.toString();
    return (key && this.sinks.get(key)) || this;
  }

  /** Makes the panel visible without taking focus from the editor. */
  reveal(): Promise<void> {
    return this.panel.reveal();
  }

  post(message: ToView): void {
    this.panel.post(message);
  }

  /** The panel tab stays hidden (context `dbclient.resultsPanel`) until something is shown in it. */
  private async showPanel(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'dbclient.resultsPanel', true);
    if (this.view) {
      this.view.show(true);
    } else {
      await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`, { preserveFocus: true });
    }
  }

  /** Answers a request of the results UI shown by `sink`. */
  async answer(sink: ResultsSink, message: FromView): Promise<void> {
    switch (message.type) {
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.setStatusBarMessage(t('Copied to clipboard'), 2000);
        return;
      case 'save': {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${message.name}.${message.format}`),
          filters: message.format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
        });
        if (target) {
          await vscode.workspace.fs.writeFile(target, Buffer.from(message.content, 'utf8'));
          vscode.window.setStatusBarMessage(t('Saved {0}', target.fsPath), 3000);
        }
        return;
      }
      case 'saveXlsx': {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${message.name}.xlsx`),
          filters: { Excel: ['xlsx'] },
        });
        if (target) {
          await vscode.workspace.fs.writeFile(target, buildXlsx({ name: message.sheet, columns: message.columns, types: message.types, rows: message.rows }));
          vscode.window.setStatusBarMessage(t('Saved {0}', target.fsPath), 3000);
        }
        return;
      }
      case 'commit':
        await this.commitHandler?.(sink, message.editId, message.changes);
        return;
      case 'rowSql':
        await this.rowSqlHandler?.(message.source, message.kind, message.row);
        return;
      case 'reveal': {
        const { uri, line, character } = message.location;
        const editor = this.for(uri);
        if (editor.goto) {
          editor.goto(line, character);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const position = new vscode.Position(line, character);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
        return;
      }
    }
  }
}
