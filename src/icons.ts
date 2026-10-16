import * as vscode from 'vscode';
import type { DriverCategory } from './drivers/types';

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

/** Shapes a connection can pick (the form's Appearance section); also built in every color. */
export const CONNECTION_SHAPES = ['database', 'server', 'cloud-database', 'database-settings', 'server-settings', 'search-database'] as const;
export type ConnectionShape = (typeof CONNECTION_SHAPES)[number];

/** Blue is the original set; the rest live in media/icons/colors/<color>/ (scripts/build-icon-colors.mjs). */
export const CONNECTION_COLORS = ['blue', 'green', 'red', 'orange', 'purple', 'yellow', 'gray'] as const;
export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

/** Default icon shape per engine category when the connection does not pick one. */
export const DEFAULT_SHAPES: Record<DriverCategory, ConnectionShape> = {
  sql: 'database',
  kv: 'server',
  pubsub: 'cloud-database',
};

/** Shapes with a "connected" variant; the others keep their image (the tree also shows ●). */
const CONNECTED: Partial<Record<ConnectionShape, IconName>> = { database: 'database-connect', server: 'server-connect' };

const isShape = (v: unknown): v is ConnectionShape => CONNECTION_SHAPES.includes(v as ConnectionShape);
const isColor = (v: unknown): v is ConnectionColor => CONNECTION_COLORS.includes(v as ConnectionColor);

/**
 * Path of a connection icon below media/icons (`colors/red/light/database-connect.png`).
 * Unknown shapes fall back to `fallback`, unknown colors to blue.
 */
export function connectionIconPath(shape: unknown, color: unknown, connected: boolean, fallback: ConnectionShape, light = false): string {
  const base = isShape(shape) ? shape : fallback;
  const name = connected ? (CONNECTED[base] ?? base) : base;
  const dir = isColor(color) && color !== 'blue' ? `colors/${color}/` : '';
  return `${dir}${light ? 'light/' : ''}${name}.png`;
}

export function connectionIcon(shape: unknown, color: unknown, connected: boolean, fallback: ConnectionShape): { light: vscode.Uri; dark: vscode.Uri } {
  if (!base) {
    throw new Error('initIcons() was not called');
  }
  return {
    light: vscode.Uri.joinPath(base, connectionIconPath(shape, color, connected, fallback, true)),
    dark: vscode.Uri.joinPath(base, connectionIconPath(shape, color, connected, fallback)),
  };
}
