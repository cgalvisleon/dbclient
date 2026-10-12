import * as vscode from 'vscode';
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
}

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
  | { type: 'focusLog' };

type FromView =
  | { type: 'ready' }
  | { type: 'copy'; text: string }
  | { type: 'save'; format: 'csv' | 'json'; content: string; name: string }
  | { type: 'reveal'; location: NonNullable<LogEntry['location']> };

/** Bottom-panel view with one tab per result set plus the SQL output log. */
export class ResultsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private queue: ToView[] = [];
  private readyWaiters: (() => void)[] = [];

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
