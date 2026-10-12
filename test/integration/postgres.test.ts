import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from '../../src/drivers/postgres';
import { StatementError } from '../../src/drivers/types';

// Runs only against a real server: DBCLIENT_PG_HOST, _PORT, _DATABASE, _USER, _PASSWORD.
const env = process.env;
const enabled = Boolean(env.DBCLIENT_PG_HOST);

describe.skipIf(!enabled)('PostgresDriver (integration)', () => {
  const schema = `dbclient_it_${Date.now()}`;
  const driver = new PostgresDriver(
    {
      id: 'it',
      name: 'it',
      type: 'postgres',
      options: {
        host: env.DBCLIENT_PG_HOST,
        port: Number(env.DBCLIENT_PG_PORT || 5432),
        database: env.DBCLIENT_PG_DATABASE || 'postgres',
        user: env.DBCLIENT_PG_USER || 'postgres',
      },
    },
    { password: env.DBCLIENT_PG_PASSWORD },
  );
  const run = (sql: string, maxRows = 100) => driver.execute(sql, { maxRows });

  beforeAll(async () => {
    await driver.connect();
    await run(`create schema ${schema}`);
    await run(`create table ${schema}.items (id int primary key, name text not null, tags jsonb)`);
    await run(`create view ${schema}.v_items as select id from ${schema}.items`);
  });

  afterAll(async () => {
    await run(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    await driver.disconnect();
  });

  it('reports affected rows for DML and columns/types for queries', async () => {
    const insert = await run(`insert into ${schema}.items select g, 'n' || g, '{"a":1}' from generate_series(1, 25) g`);
    expect(insert.command).toBe('INSERT');
    expect(insert.rowCount).toBe(25);
    expect(insert.columns).toEqual([]);

    const select = await run(`select id, name, tags, id as id from ${schema}.items order by id`);
    expect(select.columns.map((c) => c.name)).toEqual(['id', 'name', 'tags', 'id']);
    expect(select.columns[0].type).toBe('int4');
    expect(select.rows[0]).toEqual([1, 'n1', { a: 1 }, 1]);
    expect(select.rowCount).toBe(25);
    expect(select.truncated).toBe(false);
  });

  it('truncates at maxRows', async () => {
    const r = await run(`select * from ${schema}.items`, 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBeNull();
  });

  it('keeps session state between statements', async () => {
    await run(`set search_path to ${schema}`);
    const r = await run('select count(*)::int from items');
    expect(r.rows[0][0]).toBe(25);
    await run('reset search_path');
  });

  it('raises StatementError with the error position', async () => {
    const err = await run('select nope from pg_class').catch((e) => e);
    expect(err).toBeInstanceOf(StatementError);
    expect(err.position).toBe(8);
    expect(err.code).toBe('42703');
    // The session is still usable after an error.
    expect((await run('select 1')).rows).toEqual([[1]]);
  });

  it('cancels a running statement', async () => {
    const pending = run('select pg_sleep(5)').catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await driver.cancel();
    const err = await pending;
    expect(err).toBeInstanceOf(StatementError);
    expect(err.code).toBe('57014');
  });

  it('walks the tree: databases > schemas > folders > objects > columns', async () => {
    const dbs = await driver.children();
    const db = dbs.find((d) => d.description === 'default')!;
    expect(db).toBeDefined();
    const schemaNode = (await driver.children(db)).find((s) => s.label === schema)!;
    expect(schemaNode).toBeDefined();
    const folders = await driver.children(schemaNode);
    expect(folders.map((f) => f.label)).toEqual(['Tables', 'Views', 'Functions', 'Procedures', 'Indexes']);
    const tables = await driver.children(folders[0]);
    expect(tables.map((t) => t.label)).toEqual(['items']);
    const views = await driver.children(folders[1]);
    expect(views.map((v) => v.label)).toEqual(['v_items']);
    const indexes = await driver.children(folders[4]);
    expect(indexes[0].description).toBe('items');
    const columns = await driver.children(tables[0]);
    expect(columns.map((c) => `${c.label}: ${c.description}`)).toEqual([
      'id: integer · PK · not null',
      'name: text · not null',
      'tags: jsonb',
    ]);
  });
});
