import * as vscode from 'vscode';

/** Tabs showing `uri`, as a text editor or a custom editor (the DB Client SQL editor). */
function tabsOf(uri: vscode.Uri): vscode.Tab[] {
  const key = uri.toString();
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputCustom) && tab.input.uri.toString() === key);
}

/**
 * Closes every tab of `uri`, whichever editor shows it. With `revert`, unsaved changes are dropped
 * without the "save changes?" prompt (an untitled query saved elsewhere).
 */
export async function closeDocumentTabs(uri: vscode.Uri, revert = false): Promise<void> {
  const [first] = tabsOf(uri);
  if (!first) {
    return;
  }
  if (revert) {
    const input = first.input as vscode.TabInputText | vscode.TabInputCustom;
    const viewType = input instanceof vscode.TabInputCustom ? input.viewType : 'default';
    // Focus that very tab (showTextDocument would open a text tab next to a SQL editor), then revert it.
    await vscode.commands.executeCommand('vscode.openWith', input.uri, viewType, { viewColumn: first.group.viewColumn, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  const rest = tabsOf(uri);
  if (rest.length) {
    await vscode.window.tabGroups.close(rest);
  }
}
