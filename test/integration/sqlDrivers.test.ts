import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mssqlFactory } from '../../src/drivers/mssql';
import { mysqlFactory } from '../../src/drivers/mysql';
import { oracleFactory } from '../../src/drivers/oracle';
import { sqliteFactory } from '../../src/drivers/sqlite';
import { DbNode, DriverFactory, SqlDriver, StatementError } from '../../src/drivers/types';

// Each engine runs only when its env vars are set:
//   DBCLIENT_MYSQL_HOST/_PORT/_USER/_PASSWORD
//   DBCLIENT_MSSQL_HOST/_PORT/_USER/_PASSWORD
//   DBCLIENT_ORACLE_HOST/_PORT/_SERVICE/_USER/_PASSWORD
// SQLite always runs (temp file) when the Node runtime has node:sqlite.
const env = process.env;
const suffix = Date.now().toString(36);
const rows25 = Array.from({ length: 25 }, (_, i) => `(${i + 1}, 'n${i + 1}')`).join(', ');

interface Case {
  name: string;
  enabled: boolean;
  factory: DriverFactory;
  options: Record<string, string | number | boolean | undefined>;
  password?: string;
  /** Database (or schema) the tests run in; created by `setup` when needed. */
  database?: string;
  setup: string[];
  teardown: string[];
  insert: string;
  /** A multi-line statement with a syntax error on its 3rd line. */
  syntaxError: string;
  sessionState?: [string, string, unknown];
  sleep?: string;
  /** Labels from the connection root down to the folder that holds table `T`. */
  treePath: string[];
}

let hasNodeSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}
const sqliteFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-sqlite-')), 'it.db');

const cases: Case[] = [
  {
    name: 'mysql',
    enabled: Boolean(env.DBCLIENT_MYSQL_HOST),
    factory: mysqlFactory,
    options: { host: env.DBCLIENT_MYSQL_HOST, port: Number(env.DBCLIENT_MYSQL_PORT || 3306), user: env.DBCLIENT_MYSQL_USER || 'root' },
    password: env.DBCLIENT_MYSQL_PASSWORD,
    database: `dbclient_it_${suffix}`,
    setup: [`create database dbclient_it_${suffix}`, `create table dbclient_it_${suffix}.T (id int primary key, name varchar(50) not null)`],
    teardown: [`drop database if exists dbclient_it_${suffix}`],
    insert: `insert into T (id, name) values ${rows25}`,
    syntaxError: 'select 1\nfrom T\nwhere ((',
    sessionState: ['set @dbclient = 41 + 1', 'select @dbclient', 42],
    sleep: 'select sleep(5)',
    treePath: [`dbclient_it_${suffix}`, 'Tables'],
  },
  {
    name: 'mssql',
    enabled: Boolean(env.DBCLIENT_MSSQL_HOST),
    factory: mssqlFactory,
    options: {
      host: env.DBCLIENT_MSSQL_HOST,
      port: Number(env.DBCLIENT_MSSQL_PORT || 1433),
      user: env.DBCLIENT_MSSQL_USER || 'sa',
      database: 'master',
      encrypt: false,
      trustServerCertificate: true,
    },
    password: env.DBCLIENT_MSSQL_PASSWORD,
    database: `dbclient_it_${suffix}`,
    setup: [`create database dbclient_it_${suffix}`, `create table dbclient_it_${suffix}.dbo.T (id int primary key, name nvarchar(50) not null)`],
    teardown: [`alter database dbclient_it_${suffix} set single_user with rollback immediate`, `drop database if exists dbclient_it_${suffix}`],
    insert: `insert into T (id, name) values ${rows25}`,
    syntaxError: 'select 1\nfrom T\nwhere ((',
    sessionState: ['create table #dbclient (a int); insert into #dbclient values (42)', 'select a from #dbclient', 42],
    sleep: "waitfor delay '00:00:05'",
    treePath: [`dbclient_it_${suffix}`, 'dbo', 'Tables'],
  },
  {
    name: 'oracle',
    enabled: Boolean(env.DBCLIENT_ORACLE_HOST),
    factory: oracleFactory,
    options: {
      host: env.DBCLIENT_ORACLE_HOST,
      port: Number(env.DBCLIENT_ORACLE_PORT || 1521),
      service: env.DBCLIENT_ORACLE_SERVICE || 'FREEPDB1',
      user: env.DBCLIENT_ORACLE_USER,
      autoCommit: true,
    },
    password: env.DBCLIENT_ORACLE_PASSWORD,
    setup: [`create table T_${suffix} (id number primary key, name varchar2(50) not null)`],
    teardown: [`drop table T_${suffix} purge`],
    insert: `insert into T_${suffix} select level, 'n' || level from dual connect by level <= 25`,
    syntaxError: `select 1\nfrom T_${suffix}\nwhere ((`,
    sessionState: ["alter session set nls_date_format = 'YYYY'", "select to_char(date '2042-01-01') from dual", '2042'],
    sleep: 'select count(*) from all_objects a, all_objects b, all_objects c',
    treePath: [(env.DBCLIENT_ORACLE_USER || '').toUpperCase(), 'Tables'],
  },
  {
    name: 'sqlite',
    enabled: hasNodeSqlite,
    factory: sqliteFactory,
    options: { file: sqliteFile },
    setup: ['create table T (id integer primary key, name text not null)'],
    teardown: [],
    insert: `insert into T (id, name) values ${rows25}`,
    syntaxError: 'select 1\nfrom T\nwhere ((',
    treePath: ['Tables'],
  },
];

for (const c of cases) {
  describe.skipIf(!c.enabled)(`${c.name} driver (integration)`, () => {
    const driver = c.factory.create({ id: c.name, name: c.name, type: c.factory.type, options: c.options }, { password: c.password }) as SqlDriver;
    const table = c.name === 'oracle' ? `T_${suffix}` : 'T';
    const run = (sql: string, maxRows = 100, database = c.database) => driver.execute(sql, { maxRows, database });

    beforeAll(async () => {
      await driver.connect();
      for (const sql of c.setup) {
        await driver.execute(sql, { maxRows: 1 });
      }
    }, 60000);

    afterAll(async () => {
      await driver.disconnect();
      // Fresh connection so no session keeps the test database busy.
      const cleaner = c.factory.create({ id: 'x', name: 'x', type: c.factory.type, options: c.options }, { password: c.password }) as SqlDriver;
      for (const sql of c.teardown) {
        await cleaner.execute(sql, { maxRows: 1 }).catch((e) => console.warn(`${c.name} teardown: ${e.message}`));
      }
      await cleaner.disconnect();
    }, 60000);

    it('reports affected rows, columns and values', async () => {
      const [insert] = await run(c.insert);
      expect(insert.rowCount).toBe(25);
      expect(insert.columns).toEqual([]);

      const [select] = await run(`select id, name from ${table} order by id`);
      expect(select.columns.map((col) => col.name.toLowerCase())).toEqual(['id', 'name']);
      expect(select.rows[0].map(String)).toEqual(['1', 'n1']);
      expect(select.rowCount).toBe(25);
      expect(select.truncated).toBe(false);
    });

    it('truncates at maxRows', async () => {
      const [r] = await run(`select * from ${table}`, 10);
      expect(r.rows).toHaveLength(10);
      expect(r.truncated).toBe(true);
      // The session must still be usable afterwards.
      const [again] = await run(`select count(*) from ${table}`);
      expect(String(again.rows[0][0])).toBe('25');
    });

    it('reports where a syntax error is', async () => {
      const err = await run(c.syntaxError).catch((e) => e);
      expect(err).toBeInstanceOf(StatementError);
      if (c.name === 'sqlite') {
        return;
      }
      const line = err.line ?? c.syntaxError.slice(0, err.position - 1).split('\n').length;
      expect(line).toBe(3);
    });

    it.skipIf(!c.sessionState)('keeps session state between executions', async () => {
      const [set, get, expected] = c.sessionState!;
      await run(set);
      const [r] = await run(get);
      expect(String(r.rows[0][0])).toBe(String(expected));
    });

    it.skipIf(!c.sleep)('cancels a running statement', async () => {
      const started = Date.now();
      const pending = run(c.sleep!).catch((e) => e);
      await new Promise((r) => setTimeout(r, 700));
      await driver.cancel(c.database);
      await pending;
      expect(Date.now() - started).toBeLessThan(4000);
      // Still usable, and on the same session (its state survives the cancel).
      const [r] = await run('select 1 as one' + (c.name === 'oracle' ? ' from dual' : ''));
      expect(String(r.rows[0][0])).toBe('1');
      if (c.sessionState) {
        const [, get, expected] = c.sessionState;
        const [state] = await run(get);
        expect(String(state.rows[0][0])).toBe(String(expected));
      }
    }, 15000);

    it.skipIf(!c.sleep)('a cancel while idle does not hit the next statement', async () => {
      await driver.cancel(c.database);
      const [r] = await run('select 1 as one' + (c.name === 'oracle' ? ' from dual' : ''));
      expect(String(r.rows[0][0])).toBe('1');
    });

    it('walks the tree down to the columns', async () => {
      let level: DbNode[] = await driver.children();
      for (const label of c.treePath) {
        const node = level.find((n) => n.label === label);
        expect(node, `${label} in ${level.map((n) => n.label).join(', ')}`).toBeDefined();
        level = await driver.children(node!);
      }
      const tableNode = level.find((n) => n.label.toLowerCase() === table.toLowerCase());
      expect(tableNode, `table in ${level.map((n) => n.label).join(', ')}`).toBeDefined();
      const columns = await driver.children(tableNode!);
      expect(columns.map((n) => n.label.toLowerCase())).toEqual(['id', 'name']);
      expect(columns[0].description).toMatch(/PK/);
      expect(columns[1].description).toMatch(/not null/);
    });
  });
}
