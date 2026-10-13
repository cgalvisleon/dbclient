import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ConnectionConfig } from '../../src/drivers/types';
import { displayPath, expandPath, isInside, listDir, locationsOf, ownersOf, saveDirOf } from '../../src/store/sqlLocations';

const env = { home: '/home/ana', workspace: '/work/app' };
const conn = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'c1', name: 'c', type: 'postgres', options: {}, ...extra });

describe('paths', () => {
  it('expands ~ and ${workspaceFolder}', () => {
    expect(expandPath('~/sql', env)).toBe('/home/ana/sql');
    expect(expandPath('${workspaceFolder}/db/sql', env)).toBe('/work/app/db/sql');
    expect(expandPath('${workspaceFolder}', env)).toBe('/work/app');
    expect(expandPath('${workspaceFolder}/sql', { home: '/h' })).toBeUndefined();
    expect(expandPath('/abs/../x', env)).toBe('/x');
    expect(expandPath('~other/x', env)).toBe(path.resolve('~other/x'));
  });

  it('shows short display paths', () => {
    expect(displayPath('/home/ana/repos/sql', env)).toBe('~/repos/sql');
    expect(displayPath('${workspaceFolder}/sql', env)).toBe('${workspaceFolder}/sql');
    expect(displayPath('/srv/sql', env)).toBe('/srv/sql');
  });

  it('checks containment without prefix tricks', () => {
    expect(isInside('/a/b/c.sql', '/a')).toBe(true);
    expect(isInside('/a', '/a')).toBe(true);
    expect(isInside('/ab/c.sql', '/a')).toBe(false);
  });
});

describe('locationsOf / saveDirOf', () => {
  it('internal folder only, saving there by default', () => {
    const locations = locationsOf(conn(), '/store/c1', env);
    expect(locations).toEqual([{ kind: 'internal', path: '/store/c1', label: 'Saved', isSave: true }]);
    expect(saveDirOf(conn(), '/store/c1', env)).toBe('/store/c1');
  });

  it('linked folders, one of them the save location', () => {
    const c = conn({ sqlLocations: [{ path: '${workspaceFolder}/sql' }, { path: '~/shared', label: 'Shared' }], sqlSaveLocation: '~/shared' });
    expect(locationsOf(c, '/store/c1', env)).toEqual([
      { kind: 'internal', path: '/store/c1', label: 'Saved', isSave: false },
      { kind: 'linked', raw: '${workspaceFolder}/sql', path: '/work/app/sql', label: 'sql', isSave: false },
      { kind: 'linked', raw: '~/shared', path: '/home/ana/shared', label: 'Shared', isSave: true },
    ]);
    expect(saveDirOf(c, '/store/c1', env)).toBe('/home/ana/shared');
  });

  it('an external save location shows as its own location', () => {
    const c = conn({ sqlSaveLocation: '/srv/out' });
    expect(locationsOf(c, '/store/c1', env).map((l) => [l.kind, l.path, l.isSave])).toEqual([
      ['internal', '/store/c1', false],
      ['save', '/srv/out', true],
    ]);
  });

  it('falls back to the internal folder when the save location needs a missing workspace', () => {
    const c = conn({ sqlSaveLocation: '${workspaceFolder}/sql' });
    expect(saveDirOf(c, '/store/c1', { home: '/h' })).toBe('/store/c1');
    expect(locationsOf(c, '/store/c1', { home: '/h' })[1]).toMatchObject({ kind: 'save', path: undefined });
  });
});

describe('ownersOf', () => {
  const roots = [
    { connectionId: 'a', root: '/repo/sql' },
    { connectionId: 'b', root: '/repo/sql/reports' },
    { connectionId: 'c', root: '/repo/sql/reports' },
    { connectionId: 'd', root: '/other' },
  ];
  it('picks the most specific location and reports ties', () => {
    expect(ownersOf('/repo/sql/a.sql', roots)).toEqual(['a']);
    expect(ownersOf('/repo/sql/reports/x/y.sql', roots)).toEqual(['b', 'c']);
    expect(ownersOf('/nowhere/z.sql', roots)).toEqual([]);
  });
});

describe('listDir', () => {
  it('lists subfolders and .sql files, skipping hidden and dependency folders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-loc-'));
    for (const d of ['reports', '.git', 'node_modules', 'migrations']) fs.mkdirSync(path.join(dir, d));
    for (const f of ['b.sql', 'a 10.sql', 'a 2.sql', 'notes.md', '.hidden.sql']) fs.writeFileSync(path.join(dir, f), '');
    const listing = listDir(dir);
    expect(listing.folders.map((f) => f.name)).toEqual(['migrations', 'reports']);
    expect(listing.files.map((f) => f.name)).toEqual(['a 2.sql', 'a 10.sql', 'b.sql']);
    expect(listing.truncated).toBe(false);
    expect(listDir(dir, 2).truncated).toBe(true);
    expect(listDir(path.join(dir, 'missing')).missing).toBe(true);
  });
});
