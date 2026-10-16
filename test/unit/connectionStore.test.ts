import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore, parseExport, SecretStore } from '../../src/store/connectionStore';
import { postgresFactory } from '../../src/drivers/postgres';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

const fields = postgresFactory.fields;

describe('ConnectionStore', () => {
  let file: string;
  let secrets: MemorySecrets;
  let store: ConnectionStore;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-')), 'nested', 'connections.json');
    secrets = new MemorySecrets();
    store = new ConnectionStore(file, secrets);
  });

  it('starts empty when the file does not exist', () => {
    expect(store.list()).toEqual([]);
  });

  it('persists configs to JSON and secrets only to SecretStorage', async () => {
    const saved = await store.save(
      { name: 'local', type: 'postgres', options: { host: 'localhost', port: 5432 } },
      { password: 's3cret' },
    );
    expect(saved.id).toBeTruthy();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('s3cret');
    expect(JSON.parse(raw).connections[0].options.host).toBe('localhost');
    expect(await store.getSecrets(saved.id, fields)).toEqual({ password: 's3cret' });

    // A fresh store (another window) sees the same connections.
    expect(new ConnectionStore(file, secrets).list().map((c) => c.name)).toEqual(['local']);
  });

  it('keeps a secret when the update omits it and deletes it on null', async () => {
    const saved = await store.save({ name: 'a', type: 'postgres', options: {} }, { password: 'x' });
    await store.save({ ...saved, name: 'b' }, { password: undefined });
    expect((await store.getSecrets(saved.id, fields)).password).toBe('x');
    expect(store.list().map((c) => c.name)).toEqual(['b']);
    await store.save(saved, { password: null });
    expect((await store.getSecrets(saved.id, fields)).password).toBeUndefined();
  });

  it('duplicates with a unique name and copied secrets', async () => {
    const saved = await store.save({ name: 'db', type: 'postgres', options: { host: 'h' } }, { password: 'p' });
    const copy1 = await store.duplicate(saved.id, fields);
    const copy2 = await store.duplicate(saved.id, fields);
    expect([copy1.name, copy2.name]).toEqual(['db (copy)', 'db (copy 2)']);
    expect(copy1.id).not.toBe(saved.id);
    expect((await store.getSecrets(copy1.id, fields)).password).toBe('p');
  });

  it('deletes the config and its secrets, and notifies listeners', async () => {
    let changes = 0;
    store.onDidChange(() => changes++);
    const saved = await store.save({ name: 'db', type: 'postgres', options: {} }, { password: 'p' });
    await store.delete(saved.id, fields);
    expect(store.list()).toEqual([]);
    expect(secrets.values.size).toBe(0);
    expect(changes).toBe(2);
  });

  describe('folders', () => {
    it('nests folders and connections and persists them', async () => {
      const prod = store.createFolder('Production');
      const eu = store.createFolder('EU', prod.id);
      const a = await store.save({ name: 'a', type: 'postgres', options: {}, folderId: eu.id });
      await store.save({ name: 'b', type: 'postgres', options: {} });

      expect(store.childrenOf(undefined).folders.map((f) => f.name)).toEqual(['Production']);
      expect(store.childrenOf(undefined).connections.map((c) => c.name)).toEqual(['b']);
      expect(store.childrenOf(prod.id).folders.map((f) => f.name)).toEqual(['EU']);
      expect(store.childrenOf(eu.id).connections.map((c) => c.id)).toEqual([a.id]);
      expect(store.folderPath(eu.id)).toBe('Production / EU');

      const reopened = new ConnectionStore(file, secrets);
      expect(reopened.childrenOf(eu.id).connections.map((c) => c.name)).toEqual(['a']);
    });

    it('moves connections and folders, refusing cycles', async () => {
      const x = store.createFolder('X');
      const y = store.createFolder('Y', x.id);
      const c = await store.save({ name: 'c', type: 'postgres', options: {} });
      store.moveConnection(c.id, y.id);
      expect(store.get(c.id)?.folderId).toBe(y.id);
      store.moveConnection(c.id, undefined);
      expect(store.get(c.id)?.folderId).toBeUndefined();

      expect(() => store.moveFolder(x.id, y.id)).toThrow(/inside itself/);
      expect(() => store.moveFolder(x.id, x.id)).toThrow(/inside itself/);
      store.moveFolder(y.id, undefined);
      expect(store.childrenOf(undefined).folders.map((f) => f.name)).toEqual(['X', 'Y']);
      store.renameFolder(y.id, 'Z');
      expect(store.getFolder(y.id)?.name).toBe('Z');
    });

    it('deleting a folder moves its content up one level', async () => {
      const top = store.createFolder('Top');
      const mid = store.createFolder('Mid', top.id);
      const inner = store.createFolder('Inner', mid.id);
      const c = await store.save({ name: 'c', type: 'postgres', options: {}, folderId: mid.id });
      store.deleteFolder(mid.id);
      expect(store.get(c.id)?.folderId).toBe(top.id);
      expect(store.getFolder(inner.id)?.parentId).toBe(top.id);
      expect(store.getFolder(mid.id)).toBeUndefined();
    });

    it('shows items of a missing folder at the top level and keeps the folder on duplicate', async () => {
      const f = store.createFolder('F');
      const c = await store.save({ name: 'c', type: 'postgres', options: {}, folderId: 'gone' });
      expect(store.childrenOf(undefined).connections.map((x) => x.id)).toEqual([c.id]);
      store.moveConnection(c.id, f.id);
      const copy = await store.duplicate(c.id, fields);
      expect(copy.folderId).toBe(f.id);
    });
  });

  describe('export and import', () => {
    const fieldsOf = (type: string) => (type === 'postgres' ? fields : undefined);
    const secretKeys = (type: string) => (fieldsOf(type) ?? []).filter((f) => f.secret).map((f) => f.key);

    async function seed() {
      const prod = store.createFolder('Prod');
      const eu = store.createFolder('EU', prod.id);
      const a = await store.save({ name: 'a', type: 'postgres', folderId: eu.id, options: { host: 'h1', password: 'leaked' } as never, sqlLocations: [{ path: '${workspaceFolder}/sql' }] }, { password: 's3cret' });
      const b = await store.save({ name: 'b', type: 'postgres', options: { host: 'h2' } }, { password: 'pw' });
      return { prod, eu, a, b };
    }

    it('exports configuration without secrets, all or one folder', async () => {
      const { prod, eu, a } = await seed();
      const all = store.exportData(secretKeys);
      expect(all.format).toBe('dbclient-connections');
      expect(all.connections.map((c) => c.name).sort()).toEqual(['a', 'b']);
      expect(JSON.stringify(all)).not.toMatch(/s3cret|leaked|"password"/);
      expect(all.connections.find((c) => c.id === a.id)?.sqlLocations).toEqual([{ path: '${workspaceFolder}/sql' }]);

      const sub = store.exportData(secretKeys, prod.id);
      expect(sub.folders.map((f) => [f.name, f.parentId])).toEqual([['Prod', undefined], ['EU', prod.id]]);
      expect(sub.connections.map((c) => [c.name, c.folderId])).toEqual([['a', eu.id]]);
      expect(() => store.exportData(secretKeys, 'nope')).toThrow(/not found/);
    });

    it('restores a backup on the same store keeping ids, so secrets still match', async () => {
      const { a } = await seed();
      const backup = parseExport(JSON.stringify(store.exportData(secretKeys)));
      await store.delete(a.id, []); // connection gone, secret kept
      const result = await store.importData(backup, 'merge', fieldsOf);
      expect(result).toMatchObject({ added: ['a'], skipped: ['b'], renamed: [], removed: [], invalid: [] });
      expect(store.get(a.id)?.folderId).toBeDefined();
      expect(store.folderPath(store.get(a.id)!.folderId!)).toBe('Prod / EU');
      expect(store.listFolders()).toHaveLength(2); // existing folders reused
      expect((await store.getSecrets(a.id, fields)).password).toBe('s3cret');
    });

    it('merges into another store: renames conflicts, never overwrites, skips unknown engines', async () => {
      await seed();
      const exported = parseExport(JSON.stringify(store.exportData(secretKeys)));
      const other = new ConnectionStore(path.join(path.dirname(file), 'other.json'), new MemorySecrets());
      await other.save({ name: 'a', type: 'postgres', options: { host: 'different' } });
      const local = await other.save({ id: exported.connections.find((c) => c.name === 'b')!.id, name: 'mine', type: 'postgres', options: { host: 'x' } });
      exported.connections.push({ id: 'z', name: 'weird', type: 'cassandra', options: {} });
      const result = await other.importData(exported, 'merge', fieldsOf);
      expect(result.invalid).toEqual(['weird']);
      expect(result.renamed.sort()).toEqual(['b']);
      expect(result.added).toEqual(['a']); // 'a' sits in a folder there, so no name clash
      expect(other.get(local.id)?.name).toBe('mine');
      expect(other.list().map((c) => c.name).sort()).toEqual(['a', 'a', 'b', 'mine']);
      // A same-named connection at the same level is renamed.
      const again = await other.importData({ folders: [], connections: [{ id: 'n1', name: 'mine', type: 'postgres', options: { host: 'y' } }] }, 'merge', fieldsOf);
      expect(again.renamed).toEqual(['mine (imported)']);
    });

    it('replace removes connections missing from the file and their secrets', async () => {
      const { a, b } = await seed();
      const file2 = parseExport(JSON.stringify({ format: 'dbclient-connections', version: 1, folders: [], connections: [{ ...store.get(b.id), options: { host: 'h2-new' } }] }));
      const result = await store.importData(file2, 'replace', fieldsOf);
      expect(result.removed).toEqual([a.id]);
      expect(store.list().map((c) => [c.name, c.options.host])).toEqual([['b', 'h2-new']]);
      expect(store.listFolders()).toEqual([]);
      expect(secrets.values.has(`dbclient.${a.id}.password`)).toBe(false);
      expect((await store.getSecrets(b.id, fields)).password).toBe('pw');
    });

    it('exports chosen connections without folders, keeping icon and color', async () => {
      const { a, b } = await seed();
      store.patch(a.id, { icon: 'server', color: 'red' });
      const one = store.exportData(secretKeys, undefined, [a.id]);
      expect(one.folders).toEqual([]);
      expect(one.connections.map((c) => [c.name, c.folderId, c.icon, c.color])).toEqual([['a', undefined, 'server', 'red']]);
      expect(JSON.stringify(one)).not.toMatch(/s3cret|leaked|"password"/);
      expect(store.get(a.id)?.folderId).toBeDefined(); // the store itself is untouched
      expect(store.exportData(secretKeys, undefined, [a.id, b.id]).connections).toHaveLength(2);
    });

    it('keeps folder colors, also through export and import', async () => {
      const { prod, eu } = await seed();
      store.setFolderColor(prod.id, 'red');
      expect(new ConnectionStore(file, secrets).getFolder(prod.id)?.color).toBe('red'); // persisted
      store.setFolderColor(eu.id, 'green');
      store.setFolderColor(eu.id, undefined);
      expect(store.getFolder(eu.id)).not.toHaveProperty('color');
      expect(() => store.setFolderColor('nope', 'red')).toThrow(/not found/);
      const exported = parseExport(JSON.stringify(store.exportData(secretKeys, prod.id)));
      const other = new ConnectionStore(path.join(path.dirname(file), 'other.json'), new MemorySecrets());
      await other.importData(exported, 'merge', fieldsOf);
      expect(other.listFolders().map((f) => [f.name, f.color]).sort()).toEqual([['EU', undefined], ['Prod', 'red']]);
    });

    it('imports into a folder: top-level folders and connections go inside it', async () => {
      const { prod, a } = await seed();
      const exported = parseExport(JSON.stringify(store.exportData(secretKeys)));
      const other = new ConnectionStore(path.join(path.dirname(file), 'other.json'), new MemorySecrets());
      const target = other.createFolder('Imported');
      const result = await other.importData(exported, 'merge', fieldsOf, target.id);
      expect(result.added.sort()).toEqual(['a', 'b']);
      expect(other.folderPath(other.get(a.id)!.folderId!)).toBe('Imported / Prod / EU');
      expect(other.list().find((c) => c.name === 'b')?.folderId).toBe(target.id);
      expect(other.listFolders().find((f) => f.name === 'Prod')?.parentId).toBe(target.id);
      // A single exported connection lands directly in the folder.
      const single = parseExport(JSON.stringify(store.exportData(secretKeys, undefined, [a.id])));
      const third = new ConnectionStore(path.join(path.dirname(file), 'third.json'), new MemorySecrets());
      const folder = third.createFolder('Here');
      await third.importData(single, 'merge', fieldsOf, folder.id);
      expect(third.list().map((c) => [c.name, c.folderId])).toEqual([['a', folder.id]]);
      await expect(third.importData(single, 'replace', fieldsOf, folder.id)).rejects.toThrow(/cannot target a folder/);
      await expect(third.importData(single, 'merge', fieldsOf, 'nope')).rejects.toThrow(/not found/);
      expect(prod).toBeDefined();
    });

    it('rejects files that are not exports', () => {
      expect(() => parseExport('{')).toThrow(/Not a JSON file/);
      expect(() => parseExport('{"format":"other","connections":[]}')).toThrow(/Not a DB Client/);
      expect(parseExport('{"version":1,"connections":[]}')).toEqual({ folders: [], connections: [] });
    });
  });
});
