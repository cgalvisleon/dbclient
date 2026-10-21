import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { allDrivers, getDriver } from '../drivers/registry';
import { ConnectionConfig, ConnectionSecrets, FieldSpec } from '../drivers/types';
import { SecretUpdate } from '../store/connectionStore';
import { colorLabel, CONNECTION_COLORS, CONNECTION_SHAPES, ConnectionColor, ConnectionShape, DEFAULT_SHAPES, icon } from '../icons';
import { mediaRoots, webviewHtml } from './html';
import { t } from '../l10n';

interface FormValue {
  name: string;
  type: string;
  options: ConnectionConfig['options'];
  folderId?: string;
  sqlLocations?: ConnectionConfig['sqlLocations'];
  sqlSaveLocation?: string;
  icon?: string;
  color?: string;
}

const SHAPE_LABELS: Record<ConnectionShape, () => string> = {
  database: () => t('Database'),
  server: () => t('Server'),
  'cloud-database': () => t('Cloud'),
  'database-settings': () => t('Database with gear'),
  'server-settings': () => t('Server with gear'),
  'search-database': () => t('Database with magnifier'),
};


type FromWebview =
  | { type: 'ready' }
  | { type: 'test' | 'save'; value: FormValue; secrets: ConnectionSecrets }
  | { type: 'cancel' }
  | { type: 'browse'; field: string; folder?: boolean; append?: boolean };

const panels = new Map<string, vscode.WebviewPanel>();

/** Opens the add/edit form. One panel per edited connection; `undefined` means a new one. */
export async function openConnectionForm(
  extensionUri: vscode.Uri,
  manager: ConnectionManager,
  connectionId?: string,
  /** Folder preselected for a new connection. */
  folderId?: string,
): Promise<void> {
  const key = connectionId ?? 'new';
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const config = connectionId ? manager.config(connectionId) : undefined;
  const savedSecrets = config ? await manager.store.getSecrets(config.id, getDriver(config.type).fields) : {};
  const title = config ? t('Edit {0}', config.name) : t('New Connection');
  const panel = vscode.window.createWebviewPanel('dbclient.connectionForm', title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: mediaRoots(extensionUri),
  });
  panels.set(key, panel);
  panel.iconPath = icon('database-settings');
  panel.webview.html = webviewHtml(panel.webview, extensionUri, 'connectionForm', title);

  const post = (message: unknown) => panel.webview.postMessage(message);

  // Empty secret inputs mean "keep what is saved" when editing.
  const effectiveSecrets = (secrets: ConnectionSecrets): ConnectionSecrets => {
    const merged: ConnectionSecrets = { ...savedSecrets };
    for (const [k, v] of Object.entries(secrets)) {
      if (v) {
        merged[k] = v;
      }
    }
    return merged;
  };

  /** Lets the driver normalize the values (shown back in the form), then checks required fields. */
  const validate = (value: FormValue, secrets: ConnectionSecrets): string | undefined => {
    if (!value.name.trim()) {
      return t('Name is required.');
    }
    const fields = getDriver(value.type).fields;
    try {
      const before = { ...value.options };
      getDriver(value.type).prepare?.(value.options, secrets);
      const changed = Object.fromEntries(Object.entries(value.options).filter(([k, v]) => v !== before[k]));
      const moved = Object.fromEntries(fields.filter((f) => f.secret && secrets[f.key]).map((f) => [f.key, secrets[f.key]]));
      if (Object.keys(changed).length) {
        post({ type: 'fields', values: { ...changed, ...moved } });
      }
    } catch (err) {
      return (err as Error).message;
    }
    const current = (key: string) => value.options[key] ?? fields.find((f) => f.key === key)?.default;
    const applies = (f: FieldSpec) => !f.showWhen || f.showWhen.values.includes(current(f.showWhen.field) as string | boolean);
    const missing = fields.filter((f) => f.required && !f.secret && applies(f) && (value.options[f.key] ?? '') === '');
    return missing.length ? t('Required: {0}', missing.map((f) => t(f.label)).join(', ')) : undefined;
  };

  panel.webview.onDidReceiveMessage(async (message: FromWebview) => {
    switch (message.type) {
      case 'ready':
        post({
          type: 'init',
          drivers: allDrivers().map((d) => ({ type: d.type, label: d.label, category: d.category, fields: d.fields })),
          value: config
            ? {
                name: config.name,
                type: config.type,
                options: config.options,
                folderId: config.folderId,
                sqlLocations: config.sqlLocations,
                sqlSaveLocation: config.sqlSaveLocation,
                icon: config.icon,
                color: config.color,
              }
            : undefined,
          appearance: {
            iconsBase: panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icons')).toString(),
            shapes: CONNECTION_SHAPES.map((id) => ({ id, label: SHAPE_LABELS[id]() })),
            colors: CONNECTION_COLORS.map((id) => ({ id, label: colorLabel(id) })),
            defaults: Object.fromEntries(allDrivers().map((d) => [d.type, DEFAULT_SHAPES[d.category]])),
          },
          folderId,
          folders: manager.store
            .listFolders()
            .map((f) => ({ id: f.id, path: manager.store.folderPath(f.id) }))
            .sort((a, b) => a.path.localeCompare(b.path)),
          savedSecrets: Object.fromEntries(Object.entries(savedSecrets).map(([k, v]) => [k, Boolean(v)])),
          labels: {
            name: t('Name'),
            type: t('Type'),
            test: t('Test'),
            save: t('Save'),
            cancel: t('Cancel'),
            saved: t('saved — leave empty to keep'),
            testing: t('Testing…'),
            browse: t('Browse…'),
            folder: t('Folder'),
            sqlFiles: t('SQL files'),
            sqlSave: t('Save new files in'),
            sqlSaveDefault: t('Extension storage (default)'),
            sqlLinked: t('Linked folders'),
            sqlAddFolder: t('Add folder…'),
            sqlHint: t('One folder per line. Paths may start with ~ or ${workspaceFolder}. Unlinking never deletes files.'),
            noFolder: t('(none)'),
            appearance: t('Appearance'),
            icon: t('Icon'),
            color: t('Color'),
            automatic: t('Automatic (by engine)'),
          },
        });
        return;
      case 'cancel':
        panel.dispose();
        return;
      case 'browse': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: !message.folder,
          canSelectFolders: Boolean(message.folder),
          openLabel: t('Select'),
        });
        if (picked?.[0]) {
          post({ type: 'browsed', field: message.field, path: picked[0].fsPath, append: message.append });
        }
        return;
      }
      case 'test': {
        const error = validate(message.value, message.secrets);
        if (error) {
          post({ type: 'status', ok: false, message: error });
          return;
        }
        try {
          await manager.test({ id: config?.id ?? 'test', ...message.value }, effectiveSecrets(message.secrets));
          post({ type: 'status', ok: true, message: t('Connection succeeded.') });
        } catch (err) {
          post({ type: 'status', ok: false, message: (err as Error).message });
        }
        return;
      }
      case 'save': {
        const error = validate(message.value, message.secrets);
        if (error) {
          post({ type: 'status', ok: false, message: error });
          return;
        }
        const update: SecretUpdate = {};
        for (const field of getDriver(message.value.type).fields.filter((f) => f.secret)) {
          update[field.key] = message.secrets[field.key] || undefined;
        }
        try {
          if (config) {
            // Running sessions were opened with the old settings.
            await manager.disconnect(config.id);
          }
          await manager.store.save(
            {
              id: config?.id,
              ...message.value,
              name: message.value.name.trim(),
              folderId: message.value.folderId || undefined,
              sqlLocations: message.value.sqlLocations?.length ? message.value.sqlLocations : undefined,
              sqlSaveLocation: message.value.sqlSaveLocation || undefined,
              icon: CONNECTION_SHAPES.includes(message.value.icon as ConnectionShape) ? message.value.icon : undefined,
              color: CONNECTION_COLORS.includes(message.value.color as ConnectionColor) && message.value.color !== 'blue' ? message.value.color : undefined,
            },
            update,
          );
          panel.dispose();
        } catch (err) {
          post({ type: 'status', ok: false, message: (err as Error).message });
        }
        return;
      }
    }
  });
  panel.onDidDispose(() => panels.delete(key));
}
