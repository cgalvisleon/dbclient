import * as vscode from 'vscode';

/** PNG icons generated from img/ by scripts/build-icons.mjs (`npm run icons`). */
export type IconName =
  | 'add-folder' | 'add-record' | 'authentication' | 'cloud-database' | 'database-add' | 'database-connect'
  | 'database-remove' | 'database-settings' | 'database' | 'db-client' | 'edit-table' | 'editor' | 'error'
  | 'explorer' | 'export' | 'history' | 'import' | 'info' | 'query' | 'refresh' | 'remove-folder'
  | 'remove-record' | 'results' | 'run-query' | 'search-database' | 'search' | 'security' | 'server-add'
  | 'server-connect' | 'server-remove' | 'server-settings' | 'server' | 'settings' | 'sql-file' | 'table' | 'terminal';

let base: vscode.Uri | undefined;

export function initIcons(extensionUri: vscode.Uri): void {
  base = vscode.Uri.joinPath(extensionUri, 'media', 'icons');
}

/** Theme-aware icon: the light variant drops the dark halo the source images carry. */
export function icon(name: IconName): { light: vscode.Uri; dark: vscode.Uri } {
  if (!base) {
    throw new Error('initIcons() was not called');
  }
  return { light: vscode.Uri.joinPath(base, 'light', `${name}.png`), dark: vscode.Uri.joinPath(base, `${name}.png`) };
}
