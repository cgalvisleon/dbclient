import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { KvDriver } from '../drivers/types';
import { icon } from '../icons';
import { mediaRoots, webviewHtml } from './html';

const LIMIT = 1000;
const STRING_LIMIT = 1024 * 1024;

export interface KeyValue {
  key: string;
  db: number;
  type: string;
  ttl: number;
  /** Total elements (or bytes for strings) when known. */
  length: number;
  /** string → text; hash → [field, value][]; list → [index, value][]; set → [member][]; zset → [member, score][]; stream → [id, json][]. */
  value: string | (string | number)[][];
  truncated: boolean;
}

/** Reads a key's type, TTL and (a bounded slice of) its value. */
export async function readKey(driver: KvDriver, db: number, key: string): Promise<KeyValue> {
  const cmd = (...args: (string | number)[]) => driver.command(db, args);
  const type = String(await cmd('TYPE', key));
  const ttl = Number(await cmd('TTL', key));
  const base = { key, db, type, ttl, truncated: false };
  switch (type) {
    case 'string': {
      const length = Number(await cmd('STRLEN', key));
      const value = length > STRING_LIMIT ? String(await cmd('GETRANGE', key, 0, STRING_LIMIT - 1)) : String((await cmd('GET', key)) ?? '');
      return { ...base, length, value, truncated: length > STRING_LIMIT };
    }
    case 'hash': {
      const length = Number(await cmd('HLEN', key));
      return { ...base, length, ...(await scanPairs(cmd, 'HSCAN', key)) };
    }
    case 'list': {
      const length = Number(await cmd('LLEN', key));
      const items = (await cmd('LRANGE', key, 0, LIMIT - 1)) as string[];
      return { ...base, length, value: items.map((v, i) => [i, v]), truncated: length > LIMIT };
    }
    case 'set': {
      const length = Number(await cmd('SCARD', key));
      const members: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = (await cmd('SSCAN', key, cursor, 'COUNT', 500)) as [string, string[]];
        members.push(...batch);
        cursor = next;
      } while (cursor !== '0' && members.length < LIMIT);
      return { ...base, length, value: [...new Set(members)].slice(0, LIMIT).sort().map((m) => [m]), truncated: length > LIMIT };
    }
    case 'zset': {
      const length = Number(await cmd('ZCARD', key));
      const flat = (await cmd('ZRANGE', key, 0, LIMIT - 1, 'WITHSCORES')) as string[];
      const value: string[][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        value.push([flat[i], flat[i + 1]]);
      }
      return { ...base, length, value, truncated: length > LIMIT };
    }
    case 'stream': {
      const length = Number(await cmd('XLEN', key));
      const entries = (await cmd('XREVRANGE', key, '+', '-', 'COUNT', 200)) as [string, string[]][];
      const value = entries.map(([id, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        return [id, JSON.stringify(obj)];
      });
      return { ...base, length, value, truncated: length > 200 };
    }
    case 'none':
      throw new Error(vscode.l10n.t('The key "{0}" no longer exists.', key));
    default:
      return { ...base, length: 0, value: vscode.l10n.t('Values of type "{0}" are not supported by the viewer; use a .redis editor.', type) };
  }
}

async function scanPairs(cmd: (...args: (string | number)[]) => Promise<unknown>, command: string, key: string) {
  const pairs = new Map<string, string>();
  let cursor = '0';
  do {
    const [next, batch] = (await cmd(command, key, cursor, 'COUNT', 500)) as [string, string[]];
    for (let i = 0; i + 1 < batch.length; i += 2) {
      pairs.set(batch[i], batch[i + 1]);
    }
    cursor = next;
  } while (cursor !== '0' && pairs.size < LIMIT);
  const value = [...pairs].slice(0, LIMIT).sort(([a], [b]) => a.localeCompare(b));
  return { value, truncated: cursor !== '0' };
}

type Edit =
  | { op: 'setString'; value: string }
  | { op: 'setField'; field: string; value: string; oldField?: string }
  | { op: 'delField'; field: string }
  | { op: 'setIndex'; index: number; value: string }
  | { op: 'delIndex'; index: number }
  | { op: 'push'; value: string }
  | { op: 'addMember'; member: string; score?: string; oldMember?: string }
  | { op: 'delMember'; member: string }
  | { op: 'addEntry'; fields: Record<string, string> }
  | { op: 'delEntry'; id: string }
  | { op: 'ttl'; seconds: number | null }
  | { op: 'rename'; name: string }
  | { op: 'delete' };

/** Translates a viewer edit into Redis commands. */
export function editCommands(type: string, key: string, edit: Edit): (string | number)[][] {
  switch (edit.op) {
    case 'setString':
      return [['SET', key, edit.value, 'KEEPTTL']];
    case 'setField':
      return [...(edit.oldField !== undefined && edit.oldField !== edit.field ? [['HDEL', key, edit.oldField]] : []), ['HSET', key, edit.field, edit.value]];
    case 'delField':
      return [['HDEL', key, edit.field]];
    case 'setIndex':
      return [['LSET', key, edit.index, edit.value]];
    case 'delIndex': {
      // Lists have no delete-by-index: mark the slot, then remove the marker.
      const marker = `__dbclient_deleted_${Date.now()}__`;
      return [['LSET', key, edit.index, marker], ['LREM', key, 1, marker]];
    }
    case 'push':
      return [['RPUSH', key, edit.value]];
    case 'addMember':
      if (type === 'zset') {
        return [...(edit.oldMember !== undefined && edit.oldMember !== edit.member ? [['ZREM', key, edit.oldMember]] : []), ['ZADD', key, edit.score ?? '0', edit.member]];
      }
      return [...(edit.oldMember !== undefined && edit.oldMember !== edit.member ? [['SREM', key, edit.oldMember]] : []), ['SADD', key, edit.member]];
    case 'delMember':
      return [[type === 'zset' ? 'ZREM' : 'SREM', key, edit.member]];
    case 'addEntry':
      return [['XADD', key, '*', ...Object.entries(edit.fields).flat()]];
    case 'delEntry':
      return [['XDEL', key, edit.id]];
    case 'ttl':
      return edit.seconds === null || edit.seconds < 0 ? [['PERSIST', key]] : [['EXPIRE', key, edit.seconds]];
    case 'rename':
      return [['RENAMENX', key, edit.name]];
    case 'delete':
      return [['DEL', key]];
  }
}

const panels = new Map<string, vscode.WebviewPanel>();

/** Opens (or reveals) the value viewer of one key. */
export function openValueViewer(extensionUri: vscode.Uri, manager: ConnectionManager, connectionId: string, db: number, initialKey: string): void {
  const id = `${connectionId}/${db}/${initialKey}`;
  const existing = panels.get(id);
  if (existing) {
    existing.reveal();
    return;
  }
  let key = initialKey;
  const panel = vscode.window.createWebviewPanel('dbclient.redisValue', key, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: mediaRoots(extensionUri),
  });
  panels.set(id, panel);
  panel.onDidDispose(() => panels.delete(id));
  panel.iconPath = icon('authentication');
  panel.webview.html = webviewHtml(panel.webview, extensionUri, 'redisValue', key);
  const post = (m: unknown) => panel.webview.postMessage(m);

  const load = async () => {
    try {
      const driver = await manager.connectKv(connectionId);
      post({ type: 'value', data: await readKey(driver, db, key), connection: manager.config(connectionId).name });
    } catch (err) {
      post({ type: 'error', message: (err as Error).message });
    }
  };

  panel.webview.onDidReceiveMessage(async (m: { type: 'ready' } | { type: 'reload' } | { type: 'edit'; edit: Edit; valueType: string }) => {
    if (m.type === 'ready' || m.type === 'reload') {
      await load();
      return;
    }
    if (m.edit.op === 'delete') {
      const del = vscode.l10n.t('Delete');
      if ((await vscode.window.showWarningMessage(vscode.l10n.t('Delete key "{0}"?', key), { modal: true }, del)) !== del) {
        return;
      }
    }
    try {
      const driver = await manager.connectKv(connectionId);
      for (const command of editCommands(m.valueType, key, m.edit)) {
        const reply = await driver.command(db, command);
        if (m.edit.op === 'rename' && Number(reply) === 0) {
          throw new Error(vscode.l10n.t('A key named "{0}" already exists.', m.edit.name));
        }
      }
      if (m.edit.op === 'delete') {
        panel.dispose();
        return;
      }
      if (m.edit.op === 'rename') {
        key = m.edit.name;
        panel.title = key;
      }
      await load();
    } catch (err) {
      post({ type: 'error', message: (err as Error).message });
    }
  });
}
