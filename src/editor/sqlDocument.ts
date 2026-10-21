import * as vscode from 'vscode';
import { RunTarget } from './sqlRunner';
import { reopenWith } from './tabs';

export const SQL_EDITOR_VIEW_TYPE = 'dbclient.sqlEditor';

/**
 * Opens a SQL document in the DB Client SQL editor when `dbclient.sqlEditor.openByDefault` is on
 * (or `sqlEditor` says so, e.g. a query saved from a SQL editor), else in the text editor. Returns
 * what to run it with: the text editor, or the document with the caret at its start (the SQL editor
 * registers its results before this resolves).
 */
export async function showSqlDocument(doc: vscode.TextDocument, sqlEditor?: boolean): Promise<RunTarget> {
  sqlEditor ??= vscode.workspace.getConfiguration('dbclient').get<boolean>('sqlEditor.openByDefault', false);
  if (doc.languageId === 'sql' && sqlEditor) {
    // In place of a text tab of the same document, if there is one.
    await reopenWith(doc.uri, SQL_EDITOR_VIEW_TYPE);
    return { document: doc, selection: new vscode.Selection(0, 0, 0, 0) };
  }
  return vscode.window.showTextDocument(doc);
}

/** URI of the active tab when it is a DB Client SQL editor. */
export function activeSqlEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === SQL_EDITOR_VIEW_TYPE ? input.uri : undefined;
}

/** Whether `uri` is open in a DB Client SQL editor tab. */
export function inSqlEditor(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === SQL_EDITOR_VIEW_TYPE && tab.input.uri.toString() === uri.toString()),
  );
}
