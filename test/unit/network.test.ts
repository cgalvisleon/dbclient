import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { mssqlFactory } from '../../src/drivers/mssql';
import { natsFactory } from '../../src/drivers/nats';
import { postgresFactory } from '../../src/drivers/postgres';
import { allDrivers } from '../../src/drivers/registry';
import { fingerprint, sshFields, throughTunnel, tunnelTarget, usesSsh } from '../../src/drivers/sshTunnel';
import { sslFields, tlsOptions } from '../../src/drivers/tls';
import { ConnectionConfig } from '../../src/drivers/types';

const config = (type: string, options: ConnectionConfig['options']): ConnectionConfig => ({ id: 'x', name: 'x', type, options });

describe('SSH tunnel settings', () => {
  it('finds the target from host/port (with defaults) or the first NATS server', () => {
    expect(tunnelTarget(config('postgres', { host: 'db.internal' }), postgresFactory.fields)).toEqual({ host: 'db.internal', port: 5432 });
    expect(tunnelTarget(config('mssql', { host: 'sql', port: 14330 }), mssqlFactory.fields)).toEqual({ host: 'sql', port: 14330 });
    expect(tunnelTarget(config('nats', { servers: 'tls://user:pw@nats-1:4443, nats://nats-2:4222' }), natsFactory.fields)).toEqual({ host: 'nats-1', port: 4443 });
    expect(tunnelTarget(config('nats', { servers: 'nats-1' }), natsFactory.fields)).toEqual({ host: 'nats-1', port: 4222 });
  });

  it('points the driver at the local port and keeps the real host for TLS', () => {
    const pg = throughTunnel(config('postgres', { host: 'db.internal', port: 5432, ssl: 'verify-full' }), 40001, { host: 'db.internal' });
    expect(pg.options).toMatchObject({ host: '127.0.0.1', port: 40001, tlsServername: 'db.internal', ssl: 'verify-full' });
    const nats = throughTunnel(config('nats', { servers: 'tls://user:pw@nats-1:4443,nats://nats-2:4222' }), 40002, { host: 'nats-1' });
    expect(nats.options.servers).toBe('tls://user:pw@127.0.0.1:40002');
    expect(usesSsh(config('postgres', { ssh: 'off' }))).toBe(false);
    expect(usesSsh(config('postgres', { ssh: 'private key' }))).toBe(true);
  });

  it('prints host keys like ssh-keygen -lf', () => {
    expect(fingerprint(Buffer.from('key'))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('offers SSL and SSH on every network engine, not on SQLite', () => {
    for (const d of allDrivers()) {
      const keys = d.fields.map((f) => f.key);
      if (d.type === 'sqlite') {
        expect(keys).not.toContain('ssh');
        expect(keys).not.toContain('ssl');
      } else {
        expect(keys, d.type).toContain('ssh');
        expect(keys.includes('ssl') || keys.includes('encrypt'), d.type).toBe(true);
      }
    }
    expect(sshFields().filter((f) => f.secret).map((f) => f.key)).toEqual(['sshPassword', 'sshPassphrase']);
    expect(sslFields().filter((f) => f.secret).map((f) => f.key)).toEqual(['sslPassphrase']);
  });
});

describe('tlsOptions', () => {
  it('is off by default and reads PEM files when on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-tls-'));
    fs.writeFileSync(path.join(dir, 'ca.pem'), 'CA');
    expect(tlsOptions({}, {})).toBeUndefined();
    expect(tlsOptions({ ssl: 'disable', sslCa: 'x' }, {})).toBeUndefined();
    expect(tlsOptions({ ssl: 'require' }, {}, 'db.example.com')).toMatchObject({ rejectUnauthorized: false, servername: 'db.example.com' });
    const full = tlsOptions({ ssl: 'verify-full', sslCa: path.join(dir, 'ca.pem') }, { sslPassphrase: 'p' }, '10.0.0.1')!;
    expect(full).toMatchObject({ rejectUnauthorized: true, passphrase: 'p', servername: undefined });
    expect(String(full.ca)).toBe('CA');
    expect(tlsOptions({ ssl: 'verify-full', tlsServername: 'real.host' }, {}, '127.0.0.1')?.servername).toBe('real.host');
    expect(() => tlsOptions({ ssl: 'require', sslKey: '/nope.key' }, {})).toThrow(/SSL: cannot read the client key \/nope.key/);
  });
});

describe('connection form sections', () => {
  it('groups SSL and SSH fields under headings and follows the selects', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../media/connectionForm.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only' });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/l10n.js'), 'utf8'));
    window.eval(source);
    const labels = { name: 'Name', type: 'Type', test: 'Test', save: 'Save', cancel: 'Cancel', saved: 'saved', testing: 'Testing', browse: 'Browse', folder: 'Folder', sqlFiles: 'SQL files', sqlSave: 'Save', sqlSaveDefault: '', sqlLinked: 'Linked', sqlAddFolder: 'Add', sqlHint: '', noFolder: '(none)' };
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'init', drivers: [{ type: 'postgres', label: 'PostgreSQL', category: 'sql', fields: postgresFactory.fields }], folders: [], savedSecrets: {}, labels },
      }),
    );
    const doc = window.document;
    const headings = () => [...doc.querySelectorAll('h4.section')].map((h) => h.textContent);
    const ids = () => [...doc.querySelectorAll('[id^="f-"]')].map((e) => e.id.slice(2));
    expect(headings()).toEqual(['SSL / TLS', 'SSH tunnel', 'SQL files']);
    expect(ids()).toContain('ssl');
    expect(ids()).not.toContain('sslCa');
    expect(ids()).not.toContain('sshHost');

    const select = (id: string, value: string) => {
      const el = doc.getElementById(`f-${id}`) as HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(new window.Event('change'));
    };
    select('ssl', 'verify-full');
    select('ssh', 'private key');
    expect(ids()).toEqual(expect.arrayContaining(['sslCa', 'sslCert', 'sslKey', 'sslPassphrase', 'sshHost', 'sshPort', 'sshUser', 'sshKeyFile', 'sshPassphrase', 'sshHostKey']));
    expect(ids()).not.toContain('sshPassword');
    expect((doc.getElementById('f-sshPort') as HTMLInputElement).value).toBe('22');
    // The SSL fields sit after the plain ones and before the SSH section.
    const order = ids();
    expect(order.indexOf('password')).toBeLessThan(order.indexOf('ssl'));
    expect(order.indexOf('sslPassphrase')).toBeLessThan(order.indexOf('ssh'));
  });
});
