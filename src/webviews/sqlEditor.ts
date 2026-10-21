import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { DocumentBindings } from '../editor/bindings';
import { HistoryPicker, HistoryTarget } from '../editor/historyPicker';
import { reopenWith } from '../editor/tabs';
import { RunMode, SqlRunner } from '../editor/sqlRunner';
import { t } from '../l10n';
import { mediaRoots, webviewHtml } from './html';
import { ResultsChannel, ResultsView } from './resultsView';

export { SQL_EDITOR_VIEW_TYPE, showSqlDocument } from '../editor/sqlDocument';

/** A place in the document as CodeMirror and VS Code both count it (0-based line, UTF-16 column). */
interface Pos {
  line: number;
  ch: number;
}

interface Change {
  from: Pos;
  to: Pos;
  insert: string;
}

type FromEditor =
  | { type: 'editorReady' }
  /** CodeMirror is up (tests wait for it). */
  | { type: 'editorLoaded' }
  | { type: 'edit'; changes: Change[]; text: string }
  /** `auto`: the selection, or the statement at the caret. */
  | { type: 'run'; mode: 'auto' | 'statement' | 'file'; anchor: Pos; head: Pos }
  | { type: 'cancel' | 'connect' | 'disconnect' | 'history' | 'saveToFolder' | 'paste' | 'export' | 'import' | 'addConnection' | 'openAsText' | 'resultsPosition' }
  | { type: 'setConnection'; connectionId: string }
  | { type: 'setDatabase'; database: string };

/** Where the results go around the SQL: `dbclient.sqlEditor.resultsPosition`. */
export type ResultsPosition = 'bottom' | 'top' | 'left' | 'right';

const resultsPosition = (): ResultsPosition => vscode.workspace.getConfiguration('dbclient').get<ResultsPosition>('sqlEditor.resultsPosition', 'bottom');

/** Asks where to put the results and saves it for every DB Client SQL editor. */
async function pickResultsPosition(): Promise<void> {
  const current = resultsPosition();
  const items: (vscode.QuickPickItem & { position: ResultsPosition })[] = [
    { position: 'bottom', label: `$(layout-panel) ${t('Bottom')}` },
    { position: 'top', label: `$(layout-menubar) ${t('Top')}` },
    { position: 'left', label: `$(layout-sidebar-left) ${t('Left')}` },
    { position: 'right', label: `$(layout-sidebar-right) ${t('Right')}` },
  ];
  for (const item of items) {
    item.description = item.position === current ? t('current') : undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: t('Where should the results of the SQL editor go?') });
  if (picked && picked.position !== current) {
    await vscode.workspace.getConfiguration('dbclient').update('sqlEditor.resultsPosition', picked.position, vscode.ConfigurationTarget.Global);
  }
}

export interface SqlEditorState {
  connections: { id: string; name: string; engine: string; folder?: string }[];
  connectionId?: string;
  database?: string;
  /** Databases to pick from: those of the open connection, or just the current one. */
  databases: string[];
  connected: boolean;
  running: boolean;
  dialect?: string;
}

/** What a SQL editor needs from the rest of the extension. */
export interface SqlEditorServices {
  manager: ConnectionManager;
  bindings: DocumentBindings;
  runner: SqlRunner;
  results: ResultsView;
  history: HistoryPicker;
}

/**
 * DB Client SQL editor (NetBeans style), an optional editor for `.sql` files: a toolbar with the
 * connection and database as drop-downs and icon buttons, the SQL in CodeMirror, and the results
 * of its runs below. The file stays a VS Code text document (save, undo, dirty state, Git); the
 * webview mirrors it and sends its edits back.
 */
export class SqlEditorProvider implements vscode.CustomTextEditorProvider {
  /** Open editors by document URI. */
  readonly sessions = new Map<string, SqlEditorSession>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: SqlEditorServices,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const session = new SqlEditorSession(this.extensionUri, this.services, document, panel);
    this.sessions.set(key, session);
    panel.onDidDispose(() => {
      session.dispose();
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
      }
    });
  }
}

export class SqlEditorSession implements vscode.Disposable {
  /** Results of this editor's runs, shown under the SQL. */
  readonly channel: ResultsChannel;
  /** The text the webview has, to tell its own edits from other changes of the document. */
  private webviewText: string;
  /** Edits are applied in order, and a run waits for the ones before it. */
  private edits: Promise<void> = Promise.resolve();
  private stateVersion = 0;
  private resolveLoaded!: () => void;
  /** Resolves once the webview created its CodeMirror editor. */
  readonly loaded = new Promise<void>((resolve) => (this.resolveLoaded = resolve));
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly services: SqlEditorServices,
    readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const { manager, bindings, runner, results } = services;
    this.webviewText = document.getText();
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: mediaRoots(extensionUri) };
    this.channel = new ResultsChannel(
      results,
      async () => {
        if (!panel.visible) {
          panel.reveal(undefined, true);
        }
        this.post({ type: 'showResults' });
      },
      (line, character) => {
        panel.reveal();
        this.post({ type: 'goto', line, character });
      },
    );
    this.channel.attach(webview);
    webview.html = webviewHtml(webview, extensionUri, 'sqlEditor', t('SQL Editor'), {
      before: ['vendor/codemirror.js'],
      after: ['results.js'],
      styles: ['vendor/codicon.css', 'results.css'],
      styleNonce: true,
    });
    const refresh = () => void this.pushState();
    this.disposables.push(
      results.register(document.uri, this.channel),
      webview.onDidReceiveMessage((m: FromEditor) => this.receive(m)),
      vscode.workspace.onDidChangeTextDocument((e) => e.document === document && this.documentChanged(e)),
      // Ctrl/Cmd+S right after typing: the page sends its last edits first; the save waits for them.
      vscode.workspace.onWillSaveTextDocument((e) => e.document === document && e.waitUntil(this.edits)),
      bindings.onDidChange((uri) => uri.toString() === document.uri.toString() && refresh()),
      manager.onDidChangeState(refresh),
      manager.store.onDidChange(refresh),
      runner.onDidChangeRunning(refresh),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient.sqlEditor.resultsPosition') && this.post({ type: 'position', position: resultsPosition() })),
    );
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private position(p: Pos): vscode.Position {
    return this.document.validatePosition(new vscode.Position(p.line, p.ch));
  }

  /** Handles a message of the webview; public so tests can drive the editor. */
  async receive(message: FromEditor | { type: string }): Promise<void> {
    if (await this.channel.handle(message)) {
      return;
    }
    const m = message as FromEditor;
    try {
      await this.handle(m);
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }

  private async handle(m: FromEditor): Promise<void> {
    const { manager, bindings, runner, history } = this.services;
    const binding = () => bindings.get(this.document);
    switch (m.type) {
      case 'editorReady':
        this.webviewText = this.document.getText();
        this.post({
          type: 'init',
          text: this.webviewText,
          document: this.document.uri.toString(),
          eol: this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
          placeholder: t('Write SQL here. Ctrl/Cmd+Enter runs the statement at the caret or the selection; Ctrl/Cmd+Shift+Enter runs everything.'),
        });
        this.post({ type: 'position', position: resultsPosition() });
        await this.pushState();
        return;
      case 'editorLoaded':
        this.resolveLoaded();
        return;
      case 'edit': {
        const apply = async () => {
          this.webviewText = m.text;
          const edit = new vscode.WorkspaceEdit();
          for (const c of m.changes) {
            edit.replace(this.document.uri, new vscode.Range(this.position(c.from), this.position(c.to)), c.insert);
          }
          await vscode.workspace.applyEdit(edit);
        };
        this.edits = this.edits.then(apply, apply);
        await this.edits;
        return;
      }
      case 'run': {
        await this.edits;
        const selection = new vscode.Selection(this.position(m.anchor), this.position(m.head));
        const mode: RunMode = m.mode === 'file' ? 'file' : m.mode === 'statement' ? { offset: this.document.offsetAt(selection.active) } : 'auto';
        // Not awaited: Stop must get through while the query runs.
        void runner.run({ document: this.document, selection }, mode).catch((err) => vscode.window.showErrorMessage((err as Error).message));
        return;
      }
      case 'cancel':
        await runner.cancel(this.document);
        return;
      case 'connect': {
        const id = binding()?.connectionId;
        if (id) {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Connecting to {0}…', manager.config(id).name) }, () => manager.connect(id));
        }
        return;
      }
      case 'disconnect': {
        const id = binding()?.connectionId;
        if (id) {
          await manager.disconnect(id);
        }
        return;
      }
      case 'history': {
        const target = this.historyTarget();
        await history.show(target.connectionId, target);
        return;
      }
      case 'saveToFolder':
        await this.edits;
        await vscode.commands.executeCommand('dbclient.saveToSqlFolder', this.document.uri);
        return;
      case 'paste': {
        const text = await vscode.env.clipboard.readText();
        if (text) {
          this.post({ type: 'insert', text });
        }
        return;
      }
      case 'export': {
        await this.edits;
        const name = this.document.isUntitled ? 'query.sql' : path.basename(this.document.uri.fsPath);
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), name)), filters: { SQL: ['sql', 'txt'] } });
        if (target) {
          await vscode.workspace.fs.writeFile(target, Buffer.from(this.document.getText(), 'utf8'));
          vscode.window.setStatusBarMessage(t('Saved {0}', target.fsPath), 3000);
        }
        return;
      }
      case 'import': {
        const [source] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQL: ['sql', 'txt'] }, openLabel: t('Import') })) ?? [];
        if (source) {
          this.post({ type: 'insert', text: Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8') });
        }
        return;
      }
      case 'setConnection':
        if (m.connectionId !== binding()?.connectionId) {
          await bindings.set(this.document, { connectionId: m.connectionId });
        }
        return;
      case 'setDatabase': {
        const current = binding();
        if (current) {
          // The connection's own database stays implicit, as when it is picked from the list.
          const own = manager.config(current.connectionId).options.database;
          await bindings.set(this.document, { connectionId: current.connectionId, database: m.database === own ? undefined : m.database });
        }
        return;
      }
      case 'addConnection':
        await vscode.commands.executeCommand('dbclient.addConnection');
        return;
      case 'resultsPosition':
        await pickResultsPosition();
        return;
      case 'openAsText':
        await reopenWith(this.document.uri, 'default');
        return;
    }
  }

  /** Query History inserts a statement of this editor's connection at its caret. */
  historyTarget(): HistoryTarget {
    return { connectionId: this.services.bindings.get(this.document)?.connectionId, insert: (text) => this.post({ type: 'insert', text }) };
  }

  /** Sends changes that did not come from the webview (undo, another editor, a file reload). */
  private documentChanged(e: vscode.TextDocumentChangeEvent): void {
    const text = this.document.getText();
    if (!e.contentChanges.length || text === this.webviewText) {
      return;
    }
    this.webviewText = text;
    this.post({
      type: 'update',
      text,
      changes: e.contentChanges.map(
        (c): Change => ({ from: { line: c.range.start.line, ch: c.range.start.character }, to: { line: c.range.end.line, ch: c.range.end.character }, insert: c.text }),
      ),
    });
  }

  /** Toolbar state: connections, the editor's connection and database, and whether a query runs. */
  async pushState(): Promise<SqlEditorState> {
    const { manager, bindings, runner } = this.services;
    const version = ++this.stateVersion;
    const connections = manager.store
      .list()
      .filter((c) => manager.factoryOf(c).category === 'sql')
      .map((c) => ({ id: c.id, name: c.name, engine: manager.factoryOf(c).label, folder: c.folderId ? manager.store.folderPath(c.folderId) || undefined : undefined }));
    const binding = bindings.get(this.document);
    const config = binding && manager.store.get(binding.connectionId);
    const state: SqlEditorState = { connections, databases: [], connected: false, running: runner.isRunning(this.document) };
    if (binding && config) {
      state.connectionId = binding.connectionId;
      state.connected = manager.isConnected(binding.connectionId);
      state.dialect = manager.factoryOf(config).dialect;
      state.database = binding.database ?? (config.options.database as string | undefined);
      state.databases = await bindings.openDatabases(binding.connectionId);
      if (state.database && !state.databases.includes(state.database)) {
        state.databases.unshift(state.database);
      }
    }
    if (version === this.stateVersion) {
      this.post({ type: 'state', state });
    }
    return state;
  }

  dispose(): void {
    this.channel.detach();
    this.disposables.splice(0).forEach((d) => d.dispose());
  }
}
