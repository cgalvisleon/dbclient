import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { allDrivers, getDriver } from '../drivers/registry';
import { ConnectionConfig, ConnectionSecrets, FieldSpec } from '../drivers/types';
import { SecretUpdate } from '../store/connectionStore';
import { icon } from '../icons';
import { mediaRoots, webviewHtml } from './html';

interface FormValue {
  name: string;
  type: string;
  options: ConnectionConfig['options'];
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'test' | 'save'; value: FormValue; secrets: ConnectionSecrets }
  | { type: 'cancel' }
  | { type: 'browse'; field: string };

const panels = new Map<string, vscode.WebviewPanel>();

/** Opens the add/edit form. One panel per edited connection; `undefined` means a new one. */
export async function openConnectionForm(
  extensionUri: vscode.Uri,
  manager: ConnectionManager,
  connectionId?: string,
): Promise<void> {
  const key = connectionId ?? 'new';
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const config = connectionId ? manager.config(connectionId) : undefined;
  const savedSecrets = config ? await manager.store.getSecrets(config.id, getDriver(config.type).fields) : {};
  const title = config ? vscode.l10n.t('Edit {0}', config.name) : vscode.l10n.t('New Connection');
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

  const validate = (value: FormValue): string | undefined => {
    if (!value.name.trim()) {
      return vscode.l10n.t('Name is required.');
    }
    const applies = (f: FieldSpec) => !f.showWhen || f.showWhen.values.includes(value.options[f.showWhen.field] as string | boolean);
    const missing = getDriver(value.type).fields.filter((f) => f.required && !f.secret && applies(f) && (value.options[f.key] ?? '') === '');
    return missing.length ? vscode.l10n.t('Required: {0}', missing.map((f) => f.label).join(', ')) : undefined;
  };

  panel.webview.onDidReceiveMessage(async (message: FromWebview) => {
    switch (message.type) {
      case 'ready':
        post({
          type: 'init',
          drivers: allDrivers().map((d) => ({ type: d.type, label: d.label, fields: d.fields })),
          value: config ? { name: config.name, type: config.type, options: config.options } : undefined,
          savedSecrets: Object.fromEntries(Object.entries(savedSecrets).map(([k, v]) => [k, Boolean(v)])),
          labels: {
            name: vscode.l10n.t('Name'),
            type: vscode.l10n.t('Type'),
            test: vscode.l10n.t('Test'),
            save: vscode.l10n.t('Save'),
            cancel: vscode.l10n.t('Cancel'),
            saved: vscode.l10n.t('saved — leave empty to keep'),
            testing: vscode.l10n.t('Testing…'),
            browse: vscode.l10n.t('Browse…'),
          },
        });
        return;
      case 'cancel':
        panel.dispose();
        return;
      case 'browse': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Select') });
        if (picked?.[0]) {
          post({ type: 'browsed', field: message.field, path: picked[0].fsPath });
        }
        return;
      }
      case 'test': {
        const error = validate(message.value);
        if (error) {
          post({ type: 'status', ok: false, message: error });
          return;
        }
        try {
          await manager.test({ id: config?.id ?? 'test', ...message.value }, effectiveSecrets(message.secrets));
          post({ type: 'status', ok: true, message: vscode.l10n.t('Connection succeeded.') });
        } catch (err) {
          post({ type: 'status', ok: false, message: (err as Error).message });
        }
        return;
      }
      case 'save': {
        const error = validate(message.value);
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
          await manager.store.save({ id: config?.id, ...message.value, name: message.value.name.trim() }, update);
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
