import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresFactory } from '../../src/drivers/postgres';
import { sqliteFactory } from '../../src/drivers/sqlite';
import { SqlDriver, StatementResult } from '../../src/drivers/types';
import { diskUsageSql, DiskUsageTarget } from '../../src/sql/diskUsage';

// Disk Usage queries on data of their own: a temporary PostgreSQL schema and a temporary SQLite file.
const env = process.env;
const schema = `dbclient_size_${Date.now().toString(36)}`;

let hasNodeSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const run = async (driver: SqlDriver, target: DiskUsageTarget, dialect: string, database?: string): Promise<StatementResult[]> => {
  const results: StatementResult[] = [];
  for (const sql of diskUsageSql(target, dialect)!.split(/;\n\n|;$/).filter((s) => s.trim())) {
    results.push(...(await driver.execute(sql, { maxRows: 1000, database })));
  }
  return results;
};

const column = (result: StatementResult, name: string): unknown[] => {
  const i = result.columns.findIndex((c) => c.name === name);
  expect(i, `column ${name}`).toBeGreaterThanOrEqual(0);
  return result.rows.map((r) => r[i]);
};

describe.skipIf(!env.DBCLIENT_PG_HOST)('disk usage: postgres', () => {
  const database = env.DBCLIENT_PG_DATABASE || 'postgres';
  const driver = postgresFactory.create(
    { id: 'pg', name: 'pg', type: 'postgres', options: { host: env.DBCLIENT_PG_HOST, port: Number(env.DBCLIENT_PG_PORT || 5432), database, user: env.DBCLIENT_PG_USER || 'postgres' } },
    { password: env.DBCLIENT_PG_PASSWORD },
  ) as SqlDriver;
  const exec = (sql: string) => driver.execute(sql, { maxRows: 1, database });

  beforeAll(async () => {
    await driver.connect();
    await exec(`create schema ${schema}`);
    await exec(`create table ${schema}.big (id int primary key, body text)`);
    await exec(`insert into ${schema}.big select g, repeat('x', 500) from generate_series(1, 2000) g`);
    await exec(`create table ${schema}.small (id int)`);
  });

  afterAll(async () => {
    await exec(`drop schema if exists ${schema} cascade`).catch((e) => console.warn(`teardown: ${e.message}`));
    await driver.disconnect();
  });

  it('lists every database of the server', async () => {
    const [result] = await run(driver, { kind: 'server' }, 'postgres', database);
    expect(column(result, 'database')).toContain(database);
    expect(Number(column(result, 'total_mb')[0])).toBeGreaterThan(0);
  });

  it('gives the database total and its tables, largest first', async () => {
    const [total, tables] = await run(driver, { kind: 'database', database }, 'postgres', database);
    expect(column(total, 'database')).toEqual([database]);
    const names = column(tables, 'table');
    expect(names).toContain('big');
    expect(names.indexOf('big')).toBeLessThan(names.indexOf('small'));
  });

  it('measures one schema', async () => {
    const [total, tables] = await run(driver, { kind: 'schema', database, schema }, 'postgres', database);
    expect(Number(column(total, 'total_mb')[0])).toBeGreaterThan(0);
    expect(column(tables, 'table')).toEqual(['big', 'small']);
  });

  it('measures one table: data plus indexes', async () => {
    const [result] = await run(driver, { kind: 'table', database, schema, name: 'big' }, 'postgres', database);
    expect(result.rows).toHaveLength(1);
    const [total, data, index] = ['total_mb', 'data_mb', 'index_mb'].map((n) => Number(column(result, n)[0]));
    expect(data).toBeGreaterThan(0);
    expect(index).toBeGreaterThan(0);
    expect(total).toBeCloseTo(data + index, 1);
  });
});

describe.skipIf(!hasNodeSqlite)('disk usage: sqlite', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-size-')), 's.db');
  const driver = sqliteFactory.create({ id: 'sqlite', name: 'sqlite', type: 'sqlite', options: { file } }, {}) as SqlDriver;

  beforeAll(async () => {
    await driver.connect();
    await driver.execute('create table t (id int, body text)', { maxRows: 1 });
    await driver.execute("insert into t select value, printf('%.500c', 'x') from generate_series(1, 2000)", { maxRows: 1 }).catch(async () => {
      for (let i = 0; i < 200; i++) {
        await driver.execute(`insert into t values (${i}, '${'x'.repeat(5000)}')`, { maxRows: 1 });
      }
    });
  });

  afterAll(async () => {
    await driver.disconnect();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('gives the file size in pages and MB', async () => {
    const [result] = await run(driver, { kind: 'server' }, 'sqlite');
    const pages = Number(column(result, 'pages')[0]);
    const pageSize = Number(column(result, 'page_size')[0]);
    expect(pages * pageSize).toBe(fs.statSync(file).size);
    expect(Number(column(result, 'total_mb')[0])).toBeGreaterThan(0);
  });
});
