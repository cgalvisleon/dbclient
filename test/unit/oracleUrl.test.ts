import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { oracleFactory } from '../../src/drivers/oracle';
import { connectString, formatJdbcUrl, parseJdbcUrl, withAddress } from '../../src/drivers/oracleUrl';
import { throughTunnel, tunnelTarget } from '../../src/drivers/sshTunnel';
import { ConnectionConfig } from '../../src/drivers/types';

const cs = (url: string, tls = false) => connectString(parseJdbcUrl(url), tls);

describe('Oracle JDBC URLs', () => {
  it('turns service names into Easy Connect', () => {
    expect(cs('jdbc:oracle:thin:@db.example.com:1521/FREEPDB1')).toBe('db.example.com:1521/FREEPDB1');
    expect(cs('jdbc:oracle:thin:@//db.example.com/orcl.example.com')).toBe('db.example.com:1521/orcl.example.com');
    expect(cs('jdbc:oracle:thin:@//db:1522/svc:dedicated')).toBe('db:1522/svc:dedicated');
    expect(cs('jdbc:oracle:thin:@//[::1]:1521/svc')).toBe('[::1]:1521/svc');
    expect(cs('  jdbc:oracle:thin:@db:1521/svc?transport_connect_timeout=5  ')).toBe('db:1521/svc?transport_connect_timeout=5');
  });

  it('sends SIDs as a descriptor', () => {
    expect(cs('jdbc:oracle:thin:@db:1521:ORCL')).toBe('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))');
    expect(cs('jdbc:oracle:thin:@db:1521:ORCL', true)).toContain('(PROTOCOL=TCPS)');
  });

  it('keeps TLS from the URL or adds it from the SSL mode', () => {
    expect(cs('jdbc:oracle:thin:@tcps://db:2484/svc')).toBe('tcps://db:2484/svc');
    expect(cs('jdbc:oracle:thin:@db:2484/svc', true)).toBe('tcps://db:2484/svc');
  });

  it('passes descriptors and aliases through', () => {
    const descriptor = '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db)(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=svc)))';
    const parsed = parseJdbcUrl(`jdbc:oracle:thin:@${descriptor}`);
    expect(parsed).toMatchObject({ kind: 'descriptor', tcps: true, host: 'db', port: 2484 });
    expect(connectString(parsed)).toBe(descriptor);
    expect(parseJdbcUrl('jdbc:oracle:thin:@prod_high?TNS_ADMIN=~/wallet')).toMatchObject({ kind: 'alias', alias: 'prod_high', configDir: '~/wallet' });
  });

  it('reads and drops credentials', () => {
    const url = parseJdbcUrl('jdbc:oracle:thin:scott/"p@ss"@//db:1521/svc');
    expect(url).toMatchObject({ user: 'scott', password: 'p@ss', host: 'db', service: 'svc' });
    expect(formatJdbcUrl({ ...url, user: undefined, password: undefined })).toBe('jdbc:oracle:thin:@//db:1521/svc');
    expect(parseJdbcUrl('jdbc:oracle:thin:hr@db:1521:XE')).toMatchObject({ user: 'hr', password: undefined, sid: 'XE' });
  });

  it('rejects what it cannot read', () => {
    expect(() => parseJdbcUrl('')).toThrow('The JDBC URL is empty.');
    expect(() => parseJdbcUrl('jdbc:oracle:thin:@db:abc/svc')).toThrow(/Unrecognized Oracle JDBC URL/);
  });

  it('round-trips through formatJdbcUrl', () => {
    for (const url of ['jdbc:oracle:thin:@//db:1521/svc', 'jdbc:oracle:thin:@db:1521:ORCL', 'jdbc:oracle:thin:@tcps://db:2484/svc?a=1&TNS_ADMIN=/w', 'jdbc:oracle:thin:@alias?TNS_ADMIN=/w']) {
      expect(cs(formatJdbcUrl(parseJdbcUrl(url)))).toBe(cs(url));
    }
  });

  it('points the URL at an SSH tunnel', () => {
    const tunneled = withAddress(parseJdbcUrl('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SID=X)))'), '127.0.0.1', 40001);
    expect(connectString(tunneled)).toBe('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=40001))(CONNECT_DATA=(SID=X)))');
    const config: ConnectionConfig = { id: 'x', name: 'x', type: 'oracle', options: { connectBy: 'JDBC URL', jdbcUrl: 'jdbc:oracle:thin:@//db.internal:1522/svc', ssh: 'password' } };
    expect(tunnelTarget(config, oracleFactory.fields)).toEqual({ host: 'db.internal', port: 1522 });
    expect(throughTunnel(config, 40002, { host: 'db.internal' }).options.jdbcUrl).toBe('jdbc:oracle:thin:@//127.0.0.1:40002/svc');
    expect(() => tunnelTarget({ ...config, options: { ...config.options, jdbcUrl: 'jdbc:oracle:thin:@alias' } }, oracleFactory.fields)).toThrow(/TNS alias/);
  });

  it('moves credentials from the URL to the form fields before saving', () => {
    const options: ConnectionConfig['options'] = { connectBy: 'JDBC URL', jdbcUrl: 'jdbc:oracle:thin:hr/secret@db:1521:XE', user: '' };
    const secrets: Record<string, string | undefined> = {};
    oracleFactory.prepare!(options, secrets);
    expect(options).toMatchObject({ user: 'hr', jdbcUrl: 'jdbc:oracle:thin:@db:1521:XE' });
    expect(secrets.password).toBe('secret');
  });
});

describe('Oracle connection form', () => {
  it('keeps host fields for existing connections and switches to the JDBC URL', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only' });
    const window = dom.window as unknown as Window & typeof globalThis & { acquireVsCodeApi: unknown; eval(code: string): unknown };
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/l10n.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '../../media/connectionForm.js'), 'utf8'));
    const labels = { name: 'Name', type: 'Type', test: 'Test', save: 'Save', cancel: 'Cancel', saved: 'saved', testing: 'Testing', browse: 'Browse', folder: 'Folder', sqlFiles: 'SQL files', sqlSave: 'Save', sqlSaveDefault: '', sqlLinked: 'Linked', sqlAddFolder: 'Add', sqlHint: '', noFolder: '(none)' };
    // Saved before JDBC URLs existed: no connectBy option.
    const value = { name: 'old', type: 'oracle', options: { host: 'db', port: 1521, service: 'svc', user: 'hr' } };
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'init', drivers: [{ type: 'oracle', label: 'Oracle', category: 'sql', fields: oracleFactory.fields }], value, folders: [], savedSecrets: {}, labels },
      }),
    );
    const doc = window.document;
    const ids = () => [...doc.querySelectorAll('[id^="f-"]')].map((e) => e.id.slice(2));
    expect(ids()).toEqual(expect.arrayContaining(['connectBy', 'host', 'port', 'service']));
    expect(ids()).not.toContain('jdbcUrl');
    const select = doc.getElementById('f-connectBy') as HTMLSelectElement;
    select.value = 'JDBC URL';
    select.dispatchEvent(new window.Event('change'));
    expect(ids()).toContain('jdbcUrl');
    expect(ids()).not.toContain('host');
    // Values normalized by the extension come back into the inputs.
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'fields', values: { jdbcUrl: 'jdbc:oracle:thin:@db:1521:XE', user: 'scott' } } }));
    expect((doc.getElementById('f-jdbcUrl') as HTMLInputElement).value).toBe('jdbc:oracle:thin:@db:1521:XE');
    expect((doc.getElementById('f-user') as HTMLInputElement).value).toBe('scott');
  });
});
