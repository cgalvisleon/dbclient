import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore, SecretStore } from '../../src/store/connectionStore';
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
});
