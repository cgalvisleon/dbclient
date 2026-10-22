import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { HistoryEntry, QueryHistory } from '../store/queryHistory';
import { DocumentBindings, EDITOR_CATEGORIES } from './bindings';
import { showSqlDocument } from './sqlDocument';
import { t } from '../l10n';

interface EntryItem extends vscode.QuickPickItem {
  entry: HistoryEntry;
}

const OPEN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: t('Open in New Editor') };
const COPY: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: t('Copy') };
const CLEAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: t('Clear History') };

/** A DB Client SQL editor that takes the picked statement at its caret. */
export interface HistoryTarget {
  connectionId?: string;
  insert(text: string): void;
}

/**
 * NetBeans-style SQL history: statements already run on a connection (or on every one), newest
 * first, searchable. Picking one inserts it into the active editor when that editor is bound to
 * the same connection, otherwise opens it in a new editor bound to its connection and database.
 */
export class HistoryPicker {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
    private readonly history: QueryHistory,
  ) {}

  /**
   * History of `connectionId`, of the active editor's connection, or of every SQL/Redis connection.
   * `target` is a DB Client SQL editor: a statement of its connection is inserted there.
   */
  async show(connectionId?: string, target?: HistoryTarget): Promise<void> {
    if (!this.history.enabled) {
      vscode.window.showInformationMessage(t('The query history is off (dbclient.historySize is 0).'));
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const scope = connectionId ?? (editor && EDITOR_CATEGORIES[editor.document.languageId] ? this.bindings.get(editor.document)?.connectionId : undefined);
    const ids = scope
      ? [scope]
      : this.manager.store
          .list()
          .filter((c) => ['sql', 'kv'].includes(this.manager.factoryOf(c).category))
          .map((c) => c.id);
    const entries = scope ? this.history.list(scope) : this.history.all(ids);
    if (!entries.length) {
      vscode.window.showInformationMessage(
        scope
          ? t('No queries have been run on {0} yet.', this.manager.config(scope).name)
          : t('No queries have been run yet.'),
      );
      return;
    }

    const pick = vscode.window.createQuickPick<EntryItem>();
    pick.title = scope ? t('Query History · {0}', this.manager.config(scope).name) : t('Query History');
    pick.placeholder = t('Search statements; Enter inserts into the editor or opens a new one');
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.buttons = scope ? [CLEAR] : [];
    pick.items = entries.map((entry) => this.item(entry, !scope));

    pick.onDidTriggerItemButton(async ({ item, button }) => {
      if (button === COPY) {
        await vscode.env.clipboard.writeText(item.entry.text);
        vscode.window.setStatusBarMessage(t('Copied to the clipboard.'), 2000);
      } else {
        pick.hide();
        await this.openNew(item.entry);
      }
    });
    pick.onDidTriggerButton(async () => {
      const clear = t('Clear');
      pick.hide();
      const answer = await vscode.window.showWarningMessage(
        t('Clear the query history of {0}?', this.manager.config(scope!).name),
        { modal: true },
        clear,
      );
      if (answer === clear) {
        this.history.clear(scope!);
      }
    });
    pick.onDidAccept(async () => {
      const item = pick.selectedItems[0];
      pick.hide();
      if (item) {
        await this.use(item.entry, target);
      }
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  }

  private item(entry: HistoryEntry, showConnection: boolean): EntryItem {
    const flat = entry.text.replace(/\s+/g, ' ').trim();
    const connection = showConnection ? this.connectionName(entry.connectionId) : undefined;
    const where = entry.language === 'redis' ? (entry.database ? `db ${entry.database}` : undefined) : entry.database;
    const facts = [new Date(entry.time).toLocaleString()];
    if (entry.durationMs !== undefined) {
      facts.push(`${entry.durationMs} ms`);
    }
    if (entry.ok && entry.rows !== undefined) {
      facts.push(t('{0} rows', entry.rows));
    }
    return {
      label: `${entry.ok ? '' : '$(error) '}${flat.length > 150 ? `${flat.slice(0, 149)}…` : flat}`,
      description: [connection, where].filter(Boolean).join(' · '),
      detail: entry.ok ? facts.join(' · ') : `${facts.join(' · ')} · ${entry.error ?? ''}`,
      buttons: [OPEN, COPY],
      entry,
    };
  }

  private connectionName(id: string): string {
    try {
      return this.manager.config(id).name;
    } catch {
      return id;
    }
  }

  /** Inserts into the active editor when it runs on the same connection; otherwise opens a new editor. */
  private async use(entry: HistoryEntry, target?: HistoryTarget): Promise<void> {
    if (target) {
      if (entry.language === 'sql' && target.connectionId === entry.connectionId) {
        target.insert(this.statementText(entry));
      } else {
        await this.openNew(entry);
      }
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const binding = editor ? this.bindings.get(editor.document) : undefined;
    if (!editor || editor.document.languageId !== entry.language || binding?.connectionId !== entry.connectionId) {
      await this.openNew(entry);
      return;
    }
    const text = this.statementText(entry);
    const doc = editor.document;
    const selection = editor.selection;
    const line = doc.lineAt(selection.active.line);
    if (selection.isEmpty && line.text.trim()) {
      // Caret on a line with code: add the statement on the next line instead of splitting that one.
      await editor.edit((e) => e.insert(line.range.end, `\n${text}`));
    } else {
      await editor.edit((e) => e.replace(selection, text));
    }
    await vscode.window.showTextDocument(doc);
  }

  private async openNew(entry: HistoryEntry): Promise<void> {
    if (!this.manager.store.list().some((c) => c.id === entry.connectionId)) {
      vscode.window.showWarningMessage(t('The connection of this statement no longer exists.'));
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: entry.language, content: `${this.statementText(entry)}\n` });
    await this.bindings.set(doc, { connectionId: entry.connectionId, database: entry.database });
    // showSqlDocument opens SQL in the DB Client SQL editor when openByDefault is on; Redis stays in the text editor.
    await showSqlDocument(doc);
  }

  /** SQL comes back without its terminator (the splitter drops it); add one so statements stay separate. */
  private statementText(entry: HistoryEntry): string {
    const text = entry.text.trim();
    if (entry.language !== 'sql') {
      return text;
    }
    let dialect: string | undefined;
    try {
      dialect = this.manager.factoryOf(this.manager.config(entry.connectionId)).dialect;
    } catch {
      dialect = undefined;
    }
    // Oracle PL/SQL blocks keep their `END;` and end with a `/` line.
    if (dialect === 'oracle' && /^(declare|begin|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))\b/i.test(text)) {
      return `${text}\n/`;
    }
    return text.endsWith(';') ? text : `${text};`;
  }
}
