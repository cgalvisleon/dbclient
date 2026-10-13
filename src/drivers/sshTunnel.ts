import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { Client, ConnectConfig } from 'ssh2';
import { expandHome } from './tls';
import { ConnectionConfig, ConnectionSecrets, Driver, DriverFactory, FieldSpec } from './types';

// SSH tunnel shared by the network drivers: the form fields, and a local port forwarded through
// the SSH server to the database, so drivers simply connect to 127.0.0.1:<port>.

export const SSH_SECTION = 'SSH tunnel';
const ON = ['password', 'private key'];

export function sshFields(): FieldSpec[] {
  const when = { field: 'ssh', values: ON };
  return [
    { key: 'ssh', label: 'SSH tunnel', kind: 'select', default: 'off', choices: ['off', ...ON], section: SSH_SECTION },
    { key: 'sshHost', label: 'SSH host', kind: 'text', required: true, showWhen: when, section: SSH_SECTION, hint: 'Host and port above are then resolved from the SSH server.' },
    { key: 'sshPort', label: 'SSH port', kind: 'number', default: 22, showWhen: when, section: SSH_SECTION },
    { key: 'sshUser', label: 'SSH user', kind: 'text', required: true, showWhen: when, section: SSH_SECTION },
    { key: 'sshPassword', label: 'SSH password', kind: 'password', secret: true, showWhen: { field: 'ssh', values: ['password'] }, section: SSH_SECTION },
    { key: 'sshKeyFile', label: 'Private key', kind: 'file', required: true, placeholder: '~/.ssh/id_ed25519', showWhen: { field: 'ssh', values: ['private key'] }, section: SSH_SECTION },
    { key: 'sshPassphrase', label: 'Key passphrase', kind: 'password', secret: true, showWhen: { field: 'ssh', values: ['private key'] }, section: SSH_SECTION },
    {
      key: 'sshHostKey',
      label: 'Host key fingerprint',
      kind: 'text',
      placeholder: 'SHA256:… (optional)',
      showWhen: when,
      section: SSH_SECTION,
      hint: 'When set, the connection is refused if the SSH server presents a different key (ssh-keygen -lf on its public key).',
    },
  ];
}

export function usesSsh(config: ConnectionConfig): boolean {
  return ON.includes(String(config.options.ssh ?? 'off'));
}

/** Where the database is, as seen from the SSH server. */
export function tunnelTarget(config: ConnectionConfig, fields: FieldSpec[]): { host: string; port: number } {
  const o = config.options;
  if (config.type === 'nats') {
    const first = String(o.servers || 'nats://localhost:4222').split(',')[0].trim();
    const m = /^(?:\w+:\/\/)?(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(first);
    return { host: m?.[1]?.replace(/^\[|\]$/g, '') || 'localhost', port: Number(m?.[2] || 4222) };
  }
  const defaultOf = (key: string) => fields.find((f) => f.key === key)?.default;
  return { host: String(o.host || defaultOf('host') || 'localhost'), port: Number(o.port || defaultOf('port')) };
}

/** The configuration the driver uses through the tunnel: 127.0.0.1:<local port>, TLS still checked against the real host. */
export function throughTunnel(config: ConnectionConfig, localPort: number, target: { host: string }): ConnectionConfig {
  const options: ConnectionConfig['options'] = { ...config.options, tlsServername: target.host };
  if (config.type === 'nats') {
    const first = String(config.options.servers || 'nats://localhost:4222').split(',')[0].trim();
    const scheme = /^(\w+:\/\/)/.exec(first)?.[1] ?? 'nats://';
    const user = /^(?:\w+:\/\/)?([^@/]*@)/.exec(first)?.[1] ?? '';
    options.servers = `${scheme}${user}127.0.0.1:${localPort}`;
  } else {
    options.host = '127.0.0.1';
    options.port = localPort;
  }
  return { ...config, options };
}

export interface Tunnel {
  localPort: number;
  close(): Promise<void>;
}

/** `SHA256:<base64>` of a host key, as `ssh-keygen -lf` prints it. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export async function openTunnel(
  options: ConnectionConfig['options'],
  secrets: ConnectionSecrets,
  target: { host: string; port: number },
  onClose?: () => void,
): Promise<Tunnel> {
  const client = new Client();
  const raw = String(options.sshHostKey ?? '').trim().replace(/=+$/, '');
  const expected = raw && !raw.startsWith('SHA256:') ? `SHA256:${raw}` : raw;
  let seenKey = '';
  const config: ConnectConfig = {
    host: String(options.sshHost || ''),
    port: Number(options.sshPort || 22),
    username: String(options.sshUser || ''),
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    hostVerifier: (key: Buffer) => {
      seenKey = fingerprint(key);
      return !expected || seenKey === expected;
    },
  };
  if (options.ssh === 'private key') {
    const file = expandHome(String(options.sshKeyFile || ''));
    try {
      config.privateKey = fs.readFileSync(file);
    } catch (err) {
      throw new Error(`SSH: cannot read the private key ${file}: ${(err as Error).message}`);
    }
    config.passphrase = secrets.sshPassphrase || undefined;
  } else {
    config.password = secrets.sshPassword || undefined;
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => {
      if (expected && seenKey && seenKey !== expected) {
        reject(new Error(`SSH: the server's host key is ${seenKey}, not the expected ${expected}.`));
      } else {
        reject(new Error(`SSH: ${err.message}`));
      }
    });
    client.connect(config);
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (err, stream) => {
      if (err) {
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      stream.on('close', () => socket.destroy());
      socket.on('error', () => stream.destroy());
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    client.end();
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    client.end();
  };
  // The SSH session dropping takes the tunnel with it.
  client.on('close', () => {
    if (!closed) {
      void close();
      onClose?.();
    }
  });
  client.on('error', () => undefined);
  return { localPort: (server.address() as net.AddressInfo).port, close };
}

/**
 * Creates and connects a driver, through an SSH tunnel when the connection uses one; the
 * driver's disconnect also closes the tunnel. `onTunnelClosed` fires if SSH drops on its own.
 */
export async function connectDriver(
  factory: DriverFactory,
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
  onTunnelClosed?: () => void,
): Promise<Driver> {
  if (!usesSsh(config)) {
    const driver = factory.create(config, secrets);
    try {
      await driver.connect();
    } catch (err) {
      await driver.disconnect().catch(() => undefined);
      throw err;
    }
    return driver;
  }
  const target = tunnelTarget(config, factory.fields);
  const tunnel = await openTunnel(config.options, secrets, target, onTunnelClosed);
  const driver = factory.create(throughTunnel(config, tunnel.localPort, target), secrets);
  const disconnect = driver.disconnect.bind(driver);
  driver.disconnect = async () => {
    try {
      await disconnect();
    } finally {
      await tunnel.close();
    }
  };
  try {
    await driver.connect();
  } catch (err) {
    await driver.disconnect().catch(() => undefined);
    throw err;
  }
  return driver;
}
