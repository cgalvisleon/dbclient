import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sqlFileName, SqlFileStore } from '../../src/store/sqlFiles';

describe('SqlFileStore', () => {
  let root: string;
  let files: SqlFileStore;

  beforeEach(() => {
    root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-sql-')), 'sql');
    files = new SqlFileStore(root);
  });

  it('creates files per connection with unique names', () => {
    const a = files.create('conn-1', 'report', 'select 1;');
    const b = files.create('conn-1', 'report.sql');
    files.create('conn-2', 'other');
    expect(path.basename(a)).toBe('report.sql');
    expect(path.basename(b)).toBe('report 2.sql');
    expect(fs.readFileSync(a, 'utf8')).toBe('select 1;');
    expect(files.list('conn-1').map((f) => f.name)).toEqual(['report.sql', 'report 2.sql']);
    expect(files.list('conn-2').map((f) => f.name)).toEqual(['other.sql']);
    expect(files.list('missing')).toEqual([]);
  });

  it('suggests the next free query name', () => {
    expect(files.nextName('c')).toBe('query 1');
    files.create('c', 'query 1');
    files.create('c', 'query 2');
    expect(files.nextName('c')).toBe('query 3');
  });

  it('tells which connection a file belongs to', () => {
    const file = files.create('conn-1', 'x');
    expect(files.connectionOf(file)).toBe('conn-1');
    expect(files.connectionOf(path.join(root, 'conn-1', 'nested', 'y.sql'))).toBeUndefined();
    expect(files.connectionOf(path.join(os.tmpdir(), 'elsewhere.sql'))).toBeUndefined();
    expect(files.connectionOf(path.join(root, 'conn-1', 'notes.txt'))).toBeUndefined();
  });

  it('renames, deletes and removes a whole connection folder, notifying listeners', () => {
    const events: (string | undefined)[] = [];
    files.onDidChange((id) => events.push(id));
    const file = files.create('c', 'a');
    files.create('c', 'b');
    expect(() => files.rename(file, 'b')).toThrow(/already exists/);
    const renamed = files.rename(file, 'renamed');
    expect(path.basename(renamed)).toBe('renamed.sql');
    files.delete(renamed);
    expect(files.list('c').map((f) => f.name)).toEqual(['b.sql']);
    files.deleteAll('c');
    expect(fs.existsSync(files.dir('c'))).toBe(false);
    expect(events).toEqual(['c', 'c', 'c', 'c', 'c']);
  });

  it('sanitizes file names', () => {
    expect(sqlFileName(' a/b:c?.SQL ')).toBe('a-b-c-.sql');
    expect(() => sqlFileName('   ')).toThrow();
    expect(() => sqlFileName('..')).toThrow();
  });

  it('relocates to another root', () => {
    files.create('c', 'a');
    const other = path.join(path.dirname(root), 'other');
    let refreshed = false;
    files.onDidChange((id) => (refreshed = id === undefined));
    files.relocate(other);
    expect(refreshed).toBe(true);
    expect(files.list('c')).toEqual([]);
    expect(files.location).toBe(other);
  });
});
