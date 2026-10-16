import * as fs from 'fs';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { icon } from '../icons';
import { mediaRoots, webviewHtml } from './html';

/** Where the extension keeps its data; resolved by activate() so the panel shows what is in use. */
export interface StoragePaths {
  globalStorage: string;
  connectionsFile: string;
  historyDir: string;
  sqlFolder: string;
  /** True when `dbclient.sqlFolder` points somewhere else than the default. */
  sqlFolderCustom: boolean;
}

export interface SettingsInfo {
  paths: () => StoragePaths;
  counts: () => { connections: number; folders: number };
}

interface PathRow {
  label: string;
  path: string;
  hint?: string;
  exists: boolean;
  kind: 'file' | 'dir';
}

interface SettingRow {
  key: string;
  label: string;
  value: unknown;
  defaultValue: unknown;
  /** Scope that sets the value, when it is not the default. */
  source?: string;
}

interface LinkRow {
  label: string;
  url: string;
}

export interface SettingsData {
  paths: PathRow[];
  secrets: string;
  settings: SettingRow[];
  environment: [string, string][];
  about: { name: string; description: string; version: string; author: string; github?: { user: string; profile: string }; links: LinkRow[] };
}

const SETTING_LABELS: Record<string, () => string> = {
  'dbclient.maxRows': () => vscode.l10n.t('Maximum rows fetched per result'),
  'dbclient.pageSize': () => vscode.l10n.t('Rows per page in the results grid'),
  'dbclient.codeLens': () => vscode.l10n.t('Run links above each statement'),
  'dbclient.sqlFolder': () => vscode.l10n.t('Folder for saved SQL files'),
  'dbclient.historySize': () => vscode.l10n.t('Query history entries per connection'),
};

/** `https://github.com/<user>/<repo>(.git)` → user and repo; undefined for other hosts. */
export function githubOf(url: string | undefined): { user: string; repo: string } | undefined {
  const m = /^(?:git\+)?https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? { user: m[1], repo: m[2] } : undefined;
}

function sqliteAvailable(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function pathRow(label: string, path: string, kind: 'file' | 'dir', hint?: string): PathRow {
  return { label, path, hint, kind, exists: fs.existsSync(path) };
}

export function settingsData(extension: vscode.Extension<unknown>, info: SettingsInfo): SettingsData {
  const pkg = extension.packageJSON as {
    name: string;
    displayName?: string;
    version: string;
    publisher: string;
    author?: string | { name: string };
    repository?: string | { url: string };
    homepage?: string;
    bugs?: { url: string };
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
  };
  const paths = info.paths();
  const counts = info.counts();
  const config = vscode.workspace.getConfiguration();
  const settings = Object.entries(pkg.contributes?.configuration?.properties ?? {}).map(([key, prop]): SettingRow => {
    const inspected = config.inspect(key);
    const source =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.l10n.t('Workspace folder')
        : inspected?.workspaceValue !== undefined
          ? vscode.l10n.t('Workspace')
          : inspected?.globalValue !== undefined
            ? vscode.l10n.t('User')
            : undefined;
    return { key, label: SETTING_LABELS[key]?.() ?? key, value: config.get(key), defaultValue: prop.default, source };
  });
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const github = githubOf(repoUrl);
  const repoPage = github ? `https://github.com/${github.user}/${github.repo}` : undefined;
  const links: LinkRow[] = [];
  if (github) {
    links.push({ label: vscode.l10n.t('GitHub profile'), url: `https://github.com/${github.user}` });
    links.push({ label: vscode.l10n.t('Repositories'), url: `https://github.com/${github.user}?tab=repositories` });
    links.push({ label: vscode.l10n.t('Source code'), url: repoPage! });
    links.push({ label: vscode.l10n.t('Releases'), url: `${repoPage}/releases` });
  }
  if (pkg.bugs?.url) {
    links.push({ label: vscode.l10n.t('Report an issue'), url: pkg.bugs.url });
  }
  return {
    paths: [
      pathRow(vscode.l10n.t('Extension storage'), paths.globalStorage, 'dir', vscode.l10n.t('User level, shared by every window and workspace.')),
      pathRow(
        vscode.l10n.t('Connections file'),
        paths.connectionsFile,
        'file',
        vscode.l10n.t('{0} connections in {1} folders, without passwords.', counts.connections, counts.folders),
      ),
      pathRow(vscode.l10n.t('Query history'), paths.historyDir, 'dir', vscode.l10n.t('One .jsonl file per connection.')),
      pathRow(
        vscode.l10n.t('Saved SQL files'),
        paths.sqlFolder,
        'dir',
        paths.sqlFolderCustom ? vscode.l10n.t('Set by dbclient.sqlFolder.') : vscode.l10n.t('Default; change it with dbclient.sqlFolder.'),
      ),
    ],
    secrets: vscode.l10n.t(
      'Passwords, tokens and key passphrases are kept in the editor secret storage (the operating system keychain) as dbclient.<connection id>.<field>, never in the connections file.',
    ),
    settings,
    environment: [
      [vscode.l10n.t('Extension'), `${pkg.publisher}.${pkg.name} ${pkg.version}`],
      [vscode.l10n.t('Editor'), `${vscode.env.appName} ${vscode.version}`],
      [vscode.l10n.t('Node.js'), process.versions.node],
      [vscode.l10n.t('Platform'), `${process.platform} ${process.arch}`],
      [vscode.l10n.t('Language'), vscode.env.language],
      [vscode.l10n.t('Remote'), vscode.env.remoteName ?? vscode.l10n.t('(none)')],
      [vscode.l10n.t('SQLite (node:sqlite)'), sqliteAvailable() ? vscode.l10n.t('available') : vscode.l10n.t('not available (needs Node 22.13 or later)')],
      [vscode.l10n.t('Oracle'), vscode.l10n.t('thin mode, no Oracle Client needed')],
    ],
    about: {
      name: pkg.displayName ?? pkg.name,
      description: vscode.l10n.t('Database client for PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis and NATS.'),
      version: pkg.version,
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? pkg.publisher),
      github: github && { user: github.user, profile: `https://github.com/${github.user}` },
      links,
    },
  };
}

let panel: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the Settings and About panel. */
export function openSettingsPanel(context: vscode.ExtensionContext, info: SettingsInfo): void {
  if (panel) {
    panel.reveal();
    return;
  }
  const current = vscode.window.createWebviewPanel('dbclient.settings', vscode.l10n.t('DB Client Settings'), vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: mediaRoots(context.extensionUri),
  });
  panel = current;
  current.iconPath = icon('settings');
  current.webview.html = webviewHtml(current.webview, context.extensionUri, 'settings', vscode.l10n.t('DB Client Settings'));
  let data = settingsData(context.extension, info);
  const send = () => {
    data = settingsData(context.extension, info);
    current.webview.postMessage({ type: 'data', data });
  };
  const disposables = [
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbclient') && send()),
    current.onDidChangeViewState((e) => e.webviewPanel.visible && send()),
  ];
  current.onDidDispose(() => {
    panel = undefined;
    disposables.forEach((d) => d.dispose());
  });
  current.webview.onDidReceiveMessage(
    async (m: { type: 'ready' } | { type: 'copy'; text: string } | { type: 'reveal'; path: string } | { type: 'link'; url: string } | { type: 'openSettings' }) => {
      switch (m.type) {
        case 'ready':
          send();
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(vscode.l10n.t('Copied to the clipboard.'), 2500);
          break;
        case 'reveal': {
          // Only the paths the panel shows. Folders are created on first use, so a missing one is
          // created; a missing file reveals its folder.
          const row = data.paths.find((p) => p.path === m.path);
          if (row) {
            let target = row.path;
            if (!fs.existsSync(target)) {
              target = row.kind === 'file' ? nodePath.dirname(target) : target;
              fs.mkdirSync(target, { recursive: true });
            }
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
          }
          break;
        }
        case 'link':
          if (data.about.links.some((l) => l.url === m.url) || data.about.github?.profile === m.url) {
            await vscode.env.openExternal(vscode.Uri.parse(m.url));
          }
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
          break;
      }
    },
  );
}
