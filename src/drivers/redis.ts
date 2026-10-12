import IORedis from 'ioredis';
import { ConnectionConfig, ConnectionSecrets, DbNode, DriverFactory, KvDriver } from './types';

type RedisClient = InstanceType<typeof IORedis>;

const SCAN_LIMIT = 5000;

// Node paths: `db` for databases, `db/f/prefix` for key groups, `db/k/key` for keys.
const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');

/** Glob-escapes a literal key prefix for SCAN MATCH. */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}

export interface KeyGroup {
  /** Next-level prefixes (`user:`) with how many keys they hold. */
  folders: { prefix: string; label: string; count: number }[];
  /** Keys that have no further separator after `prefix`. */
  keys: string[];
}

/** Groups keys one level below `prefix` by the next separator. */
export function groupKeys(keys: string[], prefix: string, separator: string): KeyGroup {
  const folders = new Map<string, number>();
  const leaves: string[] = [];
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const at = separator ? rest.indexOf(separator) : -1;
    if (at >= 0) {
      const head = rest.slice(0, at + separator.length);
      folders.set(head, (folders.get(head) ?? 0) + 1);
    } else {
      leaves.push(key);
    }
  }
  return {
    folders: [...folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([head, count]) => ({ prefix: prefix + head, label: head, count })),
    keys: leaves.sort(),
  };
}

export class RedisDriver implements KvDriver {
  readonly type = 'redis';
  private readonly clients = new Map<number, Promise<RedisClient>>();

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  get defaultDb(): number {
    return Number(this.config.options.db || 0);
  }

  private get separator(): string {
    const value = this.config.options.separator;
    return value === undefined ? ':' : String(value);
  }

  private client(db = this.defaultDb): Promise<RedisClient> {
    let client = this.clients.get(db);
    if (!client) {
      client = (async () => {
        const o = this.config.options;
        const redis = new IORedis({
          host: String(o.host || 'localhost'),
          port: Number(o.port || 6379),
          username: o.username ? String(o.username) : undefined,
          password: this.secrets.password || undefined,
          db,
          lazyConnect: true,
          connectTimeout: 10000,
          maxRetriesPerRequest: 1,
          // Give up quickly instead of retrying forever behind the user's back.
          retryStrategy: (times) => (times > 3 ? null : 500),
          connectionName: 'dbclient',
        });
        redis.on('error', () => undefined);
        redis.on('end', () => this.clients.delete(db));
        await redis.connect();
        return redis;
      })();
      client.catch(() => this.clients.delete(db));
      this.clients.set(db, client);
    }
    return client;
  }

  async connect(): Promise<void> {
    await (await this.client()).ping();
  }

  async disconnect(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (c) => (await c).quit()));
  }

  async command(db: number, args: (string | number)[]): Promise<unknown> {
    if (!args.length) {
      throw new Error('Empty command');
    }
    const [name, ...rest] = args;
    return (await this.client(db)).call(String(name), ...rest.map(String));
  }

  async scan(db: number, pattern: string, limit: number): Promise<{ keys: string[]; complete: boolean }> {
    const client = await this.client(db);
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      batch.forEach((k) => keys.add(k));
      cursor = next;
    } while (cursor !== '0' && keys.size < limit);
    return { keys: [...keys].slice(0, limit), complete: cursor === '0' && keys.size <= limit };
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      return this.databases();
    }
    const db = Number(parent.meta?.db ?? 0);
    const prefix = parent.kind === 'folder' ? (parent.meta?.prefix ?? '') : '';
    if (parent.kind !== 'database' && parent.kind !== 'folder') {
      return [];
    }
    const { keys, complete } = await this.scan(db, `${escapeGlob(prefix)}*`, SCAN_LIMIT);
    const group = groupKeys(keys, prefix, this.separator);
    const types = await this.types(db, group.keys.slice(0, 1000));
    const nodes: DbNode[] = [
      ...group.folders.map((f) => ({
        kind: 'folder' as const,
        label: f.label,
        path: makePath(String(db), 'f', f.prefix),
        expandable: true,
        description: `${f.count}${complete ? '' : '+'}`,
        meta: { db: String(db), prefix: f.prefix },
      })),
      ...group.keys.map((key) => ({
        kind: 'key' as const,
        label: key.slice(prefix.length) || key,
        path: makePath(String(db), 'k', key),
        expandable: false,
        description: types.get(key),
        tooltip: key,
        meta: { db: String(db), key },
      })),
    ];
    if (!complete) {
      nodes.push({ kind: 'info', label: `Showing the first ${SCAN_LIMIT} keys`, path: makePath(String(db), 'i', prefix), expandable: false });
    }
    return nodes;
  }

  private async databases(): Promise<DbNode[]> {
    const client = await this.client();
    const info = String(await client.call('INFO', 'keyspace'));
    const counts = new Map<number, number>();
    for (const m of info.matchAll(/^db(\d+):keys=(\d+)/gm)) {
      counts.set(Number(m[1]), Number(m[2]));
    }
    let total = 16;
    try {
      const reply = (await client.call('CONFIG', 'GET', 'databases')) as string[];
      total = Number(reply[1]) || total;
    } catch {
      // CONFIG is often disabled on managed Redis; fall back to the default 16.
    }
    const dbs = new Set([this.defaultDb, ...counts.keys()]);
    if (this.config.options.showEmptyDbs) {
      for (let i = 0; i < total; i++) {
        dbs.add(i);
      }
    }
    return [...dbs]
      .sort((a, b) => a - b)
      .map((db) => ({
        kind: 'database' as const,
        label: `db${db}`,
        path: makePath(String(db)),
        expandable: true,
        database: String(db),
        description: `${counts.get(db) ?? 0} keys${db === this.defaultDb ? ' · default' : ''}`,
        meta: { db: String(db) },
      }));
  }

  private async types(db: number, keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) {
      return new Map();
    }
    const pipeline = (await this.client(db)).pipeline();
    keys.forEach((k) => pipeline.type(k));
    const replies = (await pipeline.exec()) ?? [];
    return new Map(keys.map((k, i) => [k, String(replies[i]?.[1] ?? '')]));
  }
}

export const redisFactory: DriverFactory = {
  type: 'redis',
  label: 'Redis',
  category: 'kv',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: 6379 },
    { key: 'username', label: 'Username', kind: 'text', placeholder: 'ACL user (optional)' },
    { key: 'password', label: 'Password', kind: 'password', secret: true },
    { key: 'db', label: 'Default database', kind: 'number', default: 0 },
    { key: 'separator', label: 'Key separator', kind: 'text', default: ':', hint: 'Keys are grouped into folders by this separator.' },
    { key: 'showEmptyDbs', label: 'Show empty databases', kind: 'checkbox', default: false },
  ],
  create: (config, secrets) => new RedisDriver(config, secrets),
};
