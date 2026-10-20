import * as vscode from 'vscode';
import type { ParamValue } from '../drivers/types';
import type { GridEdit, GridRowChange } from '../editor/gridEditor';
import type { RowSqlKind } from '../sql/generate';
import { buildXlsx, XlsxCell } from '../export/xlsx';
import { mediaRoots, webviewHtml } from './html';

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

type ToView =
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

type FromView =
  | { type: 'ready' }
  | { type: 'copy'; text: string }
  | { type: 'save'; format: 'csv' | 'json'; content: string; name: string }
  | { type: 'saveXlsx'; name: string; sheet: string; columns: string[]; types: (string | undefined)[]; rows: XlsxCell[][] }
  | { type: 'reveal'; location: NonNullable<LogEntry['location']> }
  | { type: 'commit'; editId: number; changes: GridRowChange[] }
  | { type: 'rowSql'; source: number; kind: RowSqlKind; row: ParamValue[] };

/** Bottom-panel view with one tab per result set plus the SQL output log. */
export class ResultsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private queue: ToView[] = [];
  private readyWaiters: (() => void)[] = [];
  private commitHandler?: (editId: number, changes: GridRowChange[]) => Promise<void>;
  private rowSqlHandler?: (source: number, kind: RowSqlKind, row: ParamValue[]) => Promise<void>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: mediaRoots(this.extensionUri) };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'results', 'Results');
    view.webview.onDidReceiveMessage((m: FromView) => this.receive(m));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  /** Handles "Commit" from an editable grid. */
  onCommit(handler: (editId: number, changes: GridRowChange[]) => Promise<void>): void {
    this.commitHandler = handler;
  }

  /** Handles "Generate INSERT/UPDATE/DELETE" from a row's context menu. */
  onRowSql(handler: (source: number, kind: RowSqlKind, row: ParamValue[]) => Promise<void>): void {
    this.rowSqlHandler = handler;
  }

  /** Makes the panel visible without taking focus from the editor. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
    } else {
      await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`, { preserveFocus: true });
    }
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        this.readyWaiters.push(resolve);
        setTimeout(resolve, 5000);
      });
    }
  }

  post(message: ToView): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    } else {
      this.queue.push(message);
    }
  }

  private async receive(message: FromView): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.ready = true;
        const queued = this.queue;
        this.queue = [];
        queued.forEach((m) => this.post(m));
        this.readyWaiters.splice(0).forEach((resolve) => resolve());
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.setStatusBarMessage(vscode.l10n.t('Copied to clipboard'), 2000);
        return;
      case 'save': {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${message.name}.${message.format}`),
          filters: message.format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
        });
        if (target) {
          await vscode.workspace.fs.writeFile(target, Buffer.from(message.content, 'utf8'));
          vscode.window.setStatusBarMessage(vscode.l10n.t('Saved {0}', target.fsPath), 3000);
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
          vscode.window.setStatusBarMessage(vscode.l10n.t('Saved {0}', target.fsPath), 3000);
        }
        return;
      }
      case 'commit':
        await this.commitHandler?.(message.editId, message.changes);
        return;
      case 'rowSql':
        await this.rowSqlHandler?.(message.source, message.kind, message.row);
        return;
      case 'reveal': {
        const { uri, line, character } = message.location;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const position = new vscode.Position(line, character);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
        return;
      }
    }
  }
}
