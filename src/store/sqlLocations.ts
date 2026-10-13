import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig } from '../drivers/types';

// Where a SQL connection's .sql files live: its internal folder, folders the user linked, and
// the save location for new files. Pure helpers (no vscode imports) so they are unit-testable.

export interface PathEnv {
  home: string;
  /** First workspace folder, for `${workspaceFolder}` paths; undefined when none is open. */
  workspace?: string;
}

export interface SqlLocation {
  kind: 'internal' | 'linked' | 'save';
  /** As stored (may contain `~` or `${workspaceFolder}`); undefined for the internal folder. */
  raw?: string;
  /** Absolute path, or undefined when `${workspaceFolder}` cannot be resolved. */
  path?: string;
  label: string;
  /** New files go here. */
  isSave: boolean;
}

const WORKSPACE = /^\$\{workspaceFolder\}(?=$|[\\/])/;

/** Expands `~` and `${workspaceFolder}`; undefined when the path needs a workspace and none is open. */
export function expandPath(raw: string, env: PathEnv): string | undefined {
  let value = raw.trim();
  if (WORKSPACE.test(value)) {
    if (!env.workspace) {
      return undefined;
    }
    value = value.replace(WORKSPACE, env.workspace);
  } else if (/^~(?=$|[\\/])/.test(value)) {
    value = value.replace(/^~/, env.home);
  }
  return path.resolve(value);
}

/** Shortest readable form of a path: `${workspaceFolder}/…` or `~/…` when it applies. */
export function displayPath(raw: string, env: PathEnv): string {
  if (WORKSPACE.test(raw.trim())) {
    return raw.trim();
  }
  const full = expandPath(raw, env) ?? raw;
  return full === env.home || full.startsWith(env.home + path.sep) ? `~${full.slice(env.home.length)}` : full;
}

/** True when `file` is `root` or anywhere below it. */
export function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Locations of a connection: internal folder, linked folders, and an external save location when it is not linked. */
export function locationsOf(config: ConnectionConfig, internalDir: string, env: PathEnv): SqlLocation[] {
  const save = config.sqlSaveLocation ? expandPath(config.sqlSaveLocation, env) : undefined;
  const isSave = (p: string | undefined) => (config.sqlSaveLocation ? p !== undefined && p === save : false);
  const locations: SqlLocation[] = [
    { kind: 'internal', path: internalDir, label: 'Saved', isSave: !config.sqlSaveLocation },
  ];
  for (const link of config.sqlLocations ?? []) {
    const resolved = expandPath(link.path, env);
    locations.push({
      kind: 'linked',
      raw: link.path,
      path: resolved,
      label: link.label || path.basename(resolved ?? link.path.replace(/[\\/]+$/, '')) || link.path,
      isSave: isSave(resolved),
    });
  }
  if (config.sqlSaveLocation && !locations.some((l) => l.isSave)) {
    locations.push({
      kind: 'save',
      raw: config.sqlSaveLocation,
      path: save,
      label: path.basename(save ?? config.sqlSaveLocation) || config.sqlSaveLocation,
      isSave: true,
    });
  }
  return locations;
}

/** Folder for new files; the internal folder when the save location cannot be resolved. */
export function saveDirOf(config: ConnectionConfig, internalDir: string, env: PathEnv): string {
  return (config.sqlSaveLocation && expandPath(config.sqlSaveLocation, env)) || internalDir;
}

/**
 * Connections a file belongs to: the ones whose location contains it with the longest
 * (most specific) path. Several ids mean a tie the user has to resolve.
 */
export function ownersOf(file: string, roots: { connectionId: string; root: string }[]): string[] {
  let best = -1;
  let owners: string[] = [];
  for (const { connectionId, root } of roots) {
    if (!isInside(file, root)) {
      continue;
    }
    const depth = path.resolve(root).length;
    if (depth > best) {
      best = depth;
      owners = [connectionId];
    } else if (depth === best && !owners.includes(connectionId)) {
      owners.push(connectionId);
    }
  }
  return owners;
}

export interface DirListing {
  folders: { name: string; path: string }[];
  files: { name: string; path: string; modified: number }[];
  /** More entries than `limit` existed. */
  truncated: boolean;
  missing: boolean;
}

const IGNORED = new Set(['node_modules', 'bower_components', '__pycache__', 'target', 'dist', 'build', 'vendor']);

/** Subfolders and .sql files of one directory, skipping hidden and dependency folders. */
export function listDir(dir: string, limit = 1000): DirListing {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { folders: [], files: [], truncated: false, missing: true };
  }
  const folders: DirListing['folders'] = [];
  const files: DirListing['files'] = [];
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED.has(entry.name)) {
      folders.push({ name: entry.name, path: full });
      count++;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
      let modified = 0;
      try {
        modified = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      files.push({ name: entry.name, path: full, modified });
      count++;
    }
    if (count >= limit) {
      break;
    }
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.replace(/\.sql$/i, '').localeCompare(b.name.replace(/\.sql$/i, ''), undefined, { numeric: true });
  return { folders: folders.sort(byName), files: files.sort(byName), truncated: count >= limit, missing: false };
}
