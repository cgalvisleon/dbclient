import * as fs from 'fs';
import {
  Authenticator,
  connect,
  ConnectionOptions,
  credsAuthenticator,
  headers as natsHeaders,
  Msg,
  MsgHdrs,
  NatsConnection,
  nkeyAuthenticator,
  nkeys,
  Subscription as NatsSubscription,
} from 'nats';
import { expandHome, sslFields, tlsOptions } from './tls';
import { sshFields } from './sshTunnel';
import { ConnectionConfig, ConnectionSecrets, DbNode, DriverFactory, PubSubDriver, PubSubMessage, Subscription } from './types';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const makePath = (...segments: string[]) => segments.map(encodeURIComponent).join('/');

function toHeaders(values?: Record<string, string>): MsgHdrs | undefined {
  const entries = Object.entries(values ?? {}).filter(([k]) => k.trim());
  if (!entries.length) {
    return undefined;
  }
  const h = natsHeaders();
  for (const [k, v] of entries) {
    h.append(k.trim(), v);
  }
  return h;
}

function fromHeaders(h?: MsgHdrs): Record<string, string[]> | undefined {
  if (!h) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const key of h.keys()) {
    result[key] = h.values(key);
  }
  return result;
}

function toMessage(msg: Msg, subscription: number): PubSubMessage {
  return {
    subscription,
    subject: msg.subject,
    data: decoder.decode(msg.data),
    headers: fromHeaders(msg.headers),
    reply: msg.reply || undefined,
    time: new Date().toISOString(),
  };
}

/** Seeds are often pasted with a trailing newline; a bad one would only surface as a connect timeout. */
function parseSeed(seed: string): Uint8Array {
  const bytes = encoder.encode(seed.trim());
  try {
    nkeys.fromSeed(bytes);
  } catch {
    throw new Error('Invalid NKey seed: expected the user seed (starts with SU)');
  }
  return bytes;
}

function readCreds(file: string): Uint8Array {
  const full = expandHome(file);
  try {
    return fs.readFileSync(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Credentials file not found: ${full}`);
    }
    throw err;
  }
}

interface Active extends Subscription {
  handle: NatsSubscription;
}

export class NatsDriver implements PubSubDriver {
  readonly type = 'nats';
  private nc?: NatsConnection;
  private readonly subs = new Map<number, Active>();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private notifyTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: ConnectionSecrets,
  ) {}

  private options(): ConnectionOptions {
    const o = this.config.options;
    const servers = String(o.servers || 'nats://localhost:4222')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const options: ConnectionOptions = { servers, name: 'dbclient', timeout: 10000, maxReconnectAttempts: 10 };
    const host = /^(?:\w+:\/\/)?([^:/,\s]+)/.exec(servers[0] ?? '')?.[1];
    const tls = tlsOptions(o, this.secrets, host);
    if (tls) {
      options.tls = tls as ConnectionOptions['tls'];
    }
    let authenticator: Authenticator | undefined;
    switch (o.auth) {
      case 'user/password':
        options.user = String(o.user || '');
        options.pass = this.secrets.password;
        break;
      case 'token':
        options.token = this.secrets.token;
        break;
      case 'nkey':
        authenticator = nkeyAuthenticator(parseSeed(this.secrets.seed ?? ''));
        break;
      case 'credentials file':
        authenticator = credsAuthenticator(readCreds(String(o.credsFile || '')));
        break;
    }
    if (authenticator) {
      options.authenticator = authenticator;
    }
    return options;
  }

  private get connection(): NatsConnection {
    if (!this.nc || this.nc.isClosed()) {
      throw new Error('Not connected');
    }
    return this.nc;
  }

  onDidChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Coalesces bursts (message counters) into one refresh per second. */
  private notify(immediate = false): void {
    if (immediate) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
      this.listeners.forEach((l) => l());
      return;
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = undefined;
      this.listeners.forEach((l) => l());
    }, 1000);
  }

  async connect(): Promise<void> {
    if (!this.nc || this.nc.isClosed()) {
      this.nc = await connect(this.options());
    }
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.notifyTimer);
    this.subs.clear();
    const nc = this.nc;
    this.nc = undefined;
    await nc?.drain().catch(() => nc.close());
  }

  async publish(subject: string, data: string, headers?: Record<string, string>, reply?: string): Promise<void> {
    this.connection.publish(subject, encoder.encode(data), { headers: toHeaders(headers), reply: reply || undefined });
    await this.connection.flush();
  }

  async request(subject: string, data: string, headers: Record<string, string> | undefined, timeoutMs: number): Promise<PubSubMessage> {
    const msg = await this.connection.request(subject, encoder.encode(data), { timeout: timeoutMs, headers: toHeaders(headers) });
    return toMessage(msg, 0);
  }

  subscribe(subject: string, queue: string | undefined, onMessage: (message: PubSubMessage) => void): Subscription {
    const id = this.nextId++;
    const active: Active = {
      id,
      subject,
      queue: queue || undefined,
      received: 0,
      handle: this.connection.subscribe(subject, {
        queue: queue || undefined,
        callback: (err, msg) => {
          if (err) {
            return;
          }
          active.received++;
          onMessage(toMessage(msg, id));
          this.notify();
        },
      }),
    };
    this.subs.set(id, active);
    this.notify(true);
    return this.describe(active);
  }

  unsubscribe(id: number): void {
    const active = this.subs.get(id);
    if (active) {
      active.handle.unsubscribe();
      this.subs.delete(id);
      this.notify(true);
    }
  }

  subscriptions(): Subscription[] {
    return [...this.subs.values()].map((s) => this.describe(s));
  }

  private describe({ id, subject, queue, received }: Active): Subscription {
    return { id, subject, queue, received };
  }

  async children(parent?: DbNode): Promise<DbNode[]> {
    if (!parent) {
      const info = this.connection.info;
      return [
        {
          kind: 'folder',
          label: 'Subscriptions',
          path: 'subs',
          expandable: true,
          description: String(this.subs.size),
        },
        {
          kind: 'folder',
          label: 'JetStream',
          path: 'js',
          expandable: true,
          description: info?.jetstream ? undefined : 'not enabled',
        },
        {
          kind: 'info',
          label: `Server ${info?.server_name ?? ''}`.trim(),
          path: 'server',
          expandable: false,
          description: info ? `v${info.version}` : undefined,
          tooltip: info ? JSON.stringify(info, null, 2) : undefined,
        },
      ];
    }
    if (parent.path === 'subs') {
      return this.subscriptions().map((s) => ({
        kind: 'subscription' as const,
        label: s.subject,
        path: makePath('sub', String(s.id)),
        expandable: false,
        description: `${s.received} msgs${s.queue ? ` · queue ${s.queue}` : ''}`,
        meta: { id: String(s.id), subject: s.subject },
      }));
    }
    if (parent.path === 'js') {
      let jsm;
      try {
        jsm = await this.connection.jetstreamManager();
      } catch (err) {
        return [{ kind: 'info', label: (err as Error).message, path: 'js/none', expandable: false }];
      }
      const nodes: DbNode[] = [];
      for (const s of await jsm.streams.list().next()) {
        nodes.push({
          kind: 'stream',
          label: s.config.name,
          path: makePath('stream', s.config.name),
          expandable: true,
          description: `${s.state.messages} msgs · ${(s.config.subjects ?? []).join(', ')}`,
          tooltip: JSON.stringify({ config: s.config, state: s.state }, null, 2),
          meta: { stream: s.config.name },
        });
      }
      return nodes;
    }
    if (parent.kind === 'stream' && parent.meta?.stream) {
      const jsm = await this.connection.jetstreamManager();
      const consumers = await jsm.consumers.list(parent.meta.stream).next();
      return consumers.map((c) => ({
        kind: 'consumer' as const,
        label: c.name,
        path: makePath('consumer', parent.meta!.stream, c.name),
        expandable: false,
        description: `${c.num_pending} pending · ${c.num_ack_pending} ack pending`,
        tooltip: JSON.stringify(c.config, null, 2),
      }));
    }
    return [];
  }
}

export const natsFactory: DriverFactory = {
  type: 'nats',
  label: 'NATS',
  category: 'pubsub',
  fields: [
    { key: 'servers', label: 'Servers', kind: 'text', required: true, default: 'nats://localhost:4222', hint: 'Comma separated.' },
    { key: 'auth', label: 'Authentication', kind: 'select', default: 'none', choices: ['none', 'user/password', 'token', 'nkey', 'credentials file'] },
    { key: 'user', label: 'User', kind: 'text', required: true, showWhen: { field: 'auth', values: ['user/password'] } },
    { key: 'password', label: 'Password', kind: 'password', secret: true, showWhen: { field: 'auth', values: ['user/password'] } },
    { key: 'token', label: 'Token', kind: 'password', secret: true, showWhen: { field: 'auth', values: ['token'] } },
    { key: 'seed', label: 'NKey seed', kind: 'password', secret: true, showWhen: { field: 'auth', values: ['nkey'] } },
    { key: 'credsFile', label: 'Credentials file', kind: 'file', required: true, showWhen: { field: 'auth', values: ['credentials file'] } },
    ...sslFields(),
    ...sshFields(),
  ],
  create: (config, secrets) => new NatsDriver(config, secrets),
};
