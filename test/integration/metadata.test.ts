import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mssqlFactory } from '../../src/drivers/mssql';
import { mysqlFactory } from '../../src/drivers/mysql';
import { oracleFactory } from '../../src/drivers/oracle';
import { postgresFactory } from '../../src/drivers/postgres';
import { sqliteFactory } from '../../src/drivers/sqlite';
import { ConnectionConfig, DriverFactory, SqlDriver, TableRef } from '../../src/drivers/types';
import { gridStatements, openDataSql } from '../../src/sql/generate';
import { singleTableSelect } from '../../src/sql/parse';
import { toCell } from '../../src/webviews/cells';

// Catalog, describe, DDL and grid-edit transactions against every SQL engine (same env vars
// as the other integration tests). Each engine works in its own temporary database/schema/tables.
const env = process.env;
const suffix = Date.now().toString(36);

interface Case {
  name: string;
  enabled: boolean;
  factory: DriverFactory;
  options: ConnectionConfig['options'];
  password?: string;
  /** Session database for statements, also `ref.database`. */
  database?: string;
  schema?: string;
  /** Table and view names as the engine stores them. */
  table: string;
  view: string;
  setup: string[];
  teardown: string[];
}

let hasNodeSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}
const sqliteFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-meta-')), 'it.db');

const ddl = (table: string, types: { int: string; text: (n: number) => string; date: string }) => [
  `create table ${table} (id ${types.int} not null, code ${types.text(10)} not null, name ${types.text(50)} not null, born ${types.date}, primary key (id, code))`,
];

const pgSchema = `dbclient_meta_${suffix}`;
const myDb = `dbclient_meta_${suffix}`;
const msDb = `dbclient_meta_${suffix}`;
const ora = `META_${suffix}`.toUpperCase();

const cases: Case[] = [
  {
    name: 'postgres',
    enabled: Boolean(env.DBCLIENT_PG_HOST),
    factory: postgresFactory,
    options: { host: env.DBCLIENT_PG_HOST, port: Number(env.DBCLIENT_PG_PORT || 5432), database: env.DBCLIENT_PG_DATABASE || 'postgres', user: env.DBCLIENT_PG_USER || 'postgres' },
    password: env.DBCLIENT_PG_PASSWORD,
    database: env.DBCLIENT_PG_DATABASE || 'postgres',
    schema: pgSchema,
    table: 'meta_items',
    view: 'meta_v',
    setup: [
      `create schema ${pgSchema}`,
      ...ddl(`${pgSchema}.meta_items`, { int: 'int', text: (n) => `varchar(${n})`, date: 'date' }),
      `create index items_name_ix on ${pgSchema}.meta_items (name)`,
      `create view ${pgSchema}.meta_v as select id, name from ${pgSchema}.meta_items`,
    ],
    teardown: [`drop schema if exists ${pgSchema} cascade`],
  },
  {
    name: 'mysql',
    enabled: Boolean(env.DBCLIENT_MYSQL_HOST),
    factory: mysqlFactory,
    options: { host: env.DBCLIENT_MYSQL_HOST, port: Number(env.DBCLIENT_MYSQL_PORT || 3306), user: env.DBCLIENT_MYSQL_USER || 'root' },
    password: env.DBCLIENT_MYSQL_PASSWORD,
    database: myDb,
    table: 'items',
    view: 'v_items',
    setup: [
      `create database ${myDb}`,
      ...ddl(`${myDb}.items`, { int: 'int', text: (n) => `varchar(${n})`, date: 'date' }),
      `create index items_name_ix on ${myDb}.items (name)`,
      `create view ${myDb}.v_items as select id, name from ${myDb}.items`,
    ],
    teardown: [`drop database if exists ${myDb}`],
  },
  {
    name: 'mssql',
    enabled: Boolean(env.DBCLIENT_MSSQL_HOST),
    factory: mssqlFactory,
    options: { host: env.DBCLIENT_MSSQL_HOST, port: Number(env.DBCLIENT_MSSQL_PORT || 1433), user: env.DBCLIENT_MSSQL_USER || 'sa', database: 'master', encrypt: false, trustServerCertificate: true },
    password: env.DBCLIENT_MSSQL_PASSWORD,
    database: msDb,
    schema: 'dbo',
    table: 'items',
    view: 'v_items',
    setup: [
      `create database ${msDb}`,
      ...ddl(`${msDb}.dbo.items`, { int: 'int', text: (n) => `nvarchar(${n})`, date: 'datetime2(3)' }),
      `create index items_name_ix on ${msDb}.dbo.items (name)`,
      `exec ${msDb}.sys.sp_executesql N'create view dbo.v_items as select id, name from dbo.items'`,
    ],
    teardown: [`alter database ${msDb} set single_user with rollback immediate`, `drop database if exists ${msDb}`],
  },
  {
    name: 'oracle',
    enabled: Boolean(env.DBCLIENT_ORACLE_HOST),
    factory: oracleFactory,
    options: { host: env.DBCLIENT_ORACLE_HOST, port: Number(env.DBCLIENT_ORACLE_PORT || 1521), service: env.DBCLIENT_ORACLE_SERVICE || 'FREEPDB1', user: env.DBCLIENT_ORACLE_USER, autoCommit: true },
    password: env.DBCLIENT_ORACLE_PASSWORD,
    schema: (env.DBCLIENT_ORACLE_USER || '').toUpperCase(),
    table: `${ora}_ITEMS`,
    view: `${ora}_V`,
    setup: [
      ...ddl(`${ora}_ITEMS`, { int: 'number(10)', text: (n) => `varchar2(${n})`, date: 'date' }),
      `create index ${ora}_IX on ${ora}_ITEMS (name)`,
      `create view ${ora}_V as select id, name from ${ora}_ITEMS`,
    ],
    teardown: [`drop view ${ora}_V`, `drop table ${ora}_ITEMS purge`],
  },
  {
    name: 'sqlite',
    enabled: hasNodeSqlite,
    factory: sqliteFactory,
    options: { file: sqliteFile },
    table: 'items',
    view: 'v_items',
    setup: [
      ...ddl('items', { int: 'integer', text: (n) => `varchar(${n})`, date: 'date' }),
      'create index items_name_ix on items (name)',
      'create view v_items as select id, name from items',
    ],
    teardown: [],
  },
];

for (const c of cases) {
  describe.skipIf(!c.enabled)(`${c.name} metadata and grid edits (integration)`, () => {
    const driver = c.factory.create({ id: c.name, name: c.name, type: c.factory.type, options: c.options }, { password: c.password }) as SqlDriver;
    const ref: TableRef = { database: c.database, schema: c.schema, name: c.table };
    // DBMS_METADATA and DDL can take a while on a busy machine (all suites run in parallel).
    vi.setConfig({ testTimeout: 30000 });
    const query = async (sql: string) => (await driver.execute(sql, { maxRows: 100, database: c.database }))[0];

    beforeAll(async () => {
      await driver.connect();
      for (const sql of c.setup) {
        await driver.execute(sql, { maxRows: 1 });
      }
    }, 60000);

    afterAll(async () => {
      await driver.disconnect();
      const cleaner = c.factory.create({ id: 'x', name: 'x', type: c.factory.type, options: c.options }, { password: c.password }) as SqlDriver;
      for (const sql of c.teardown) {
        await cleaner.execute(sql, { maxRows: 1 }).catch((e) => console.warn(`${c.name} teardown: ${e.message}`));
      }
      await cleaner.disconnect();
    }, 60000);

    it('lists tables and views in the catalog', async () => {
      const catalog = await driver.catalog(c.database);
      // Other test files may create same-named tables in other schemas at the same time.
      const find = (name: string) => catalog.tables.find((t) => t.name === name && (!c.schema || t.schema === c.schema));
      expect(find(c.table)).toMatchObject({ kind: 'table' });
      expect(find(c.view)).toMatchObject({ kind: 'view' });
      if (c.schema) {
        expect(find(c.table)?.schema).toBe(c.schema);
      }
    });

    it('describes columns, primary key and indexes, also from an unqualified lower-case name', async () => {
      const info = (await driver.describe({ database: c.database, name: c.table.toLowerCase() }))!;
      expect(info).toBeDefined();
      expect(info.kind).toBe('table');
      expect(info.columns.map((col) => col.name.toLowerCase())).toEqual(['id', 'code', 'name', 'born']);
      expect(info.primaryKey.map((k) => k.toLowerCase())).toEqual(['id', 'code']);
      expect(info.columns.find((col) => col.name.toLowerCase() === 'name')).toMatchObject({ nullable: false, primaryKey: false });
      expect(info.columns.find((col) => col.name.toLowerCase() === 'born')?.nullable).toBe(true);
      expect(info.indexes.some((i) => i.columns.map((x) => x.toLowerCase()).join() === 'name' && !i.primary)).toBe(true);
      expect(info.indexes.some((i) => i.primary) || c.name === 'sqlite').toBe(true);
      expect((await driver.describe({ ...ref, name: c.view }))?.kind).toBe('view');
      expect(await driver.describe({ ...ref, name: 'no_such_table' })).toBeUndefined();
    });

    it('produces DDL for the table (with its index) and the view', async () => {
      const table = await driver.ddl(ref);
      expect(table).toMatch(/create table/i);
      expect(table.toLowerCase()).toContain(c.table.toLowerCase());
      expect(table).toMatch(/primary key/i);
      expect(table.toLowerCase()).toMatch(/items_name_ix|_ix/);
      const view = await driver.ddl({ ...ref, name: c.view });
      expect(view).toMatch(/view/i);
      expect(view).toMatch(/select/i);
    });

    it('commits grid edits in one transaction and keeps dates intact', async () => {
      const info = (await driver.describe(ref))!;
      const name = (n: string) => info.columns.find((col) => col.name.toLowerCase() === n)!.name;
      const born = c.name === 'oracle' ? "date '2020-02-29'" : c.name === 'mssql' ? "'2020-02-29T10:30:00'" : "'2020-02-29'";
      await driver.transaction(c.database, [
        { sql: `insert into ${c.schema && c.name !== 'oracle' ? `${c.schema}.` : ''}${c.table} (id, code, name, born) values (1, 'a', 'one', ${born})`, params: [] },
      ]);

      // Read the row as the grid does, then edit it through the generated DML.
      const select = openDataSql(info, c.name);
      expect(singleTableSelect(select)?.items).toEqual([{ star: true }]);
      const before = await query(`${select} where id = 1`);
      const cells = before.rows[0].map(toCell);
      const col = (n: string) => before.columns.findIndex((x) => x.name.toLowerCase() === n);
      const key = { [name('id')]: cells[col('id')], [name('code')]: cells[col('code')] };

      const counts = await driver.transaction(
        c.database,
        gridStatements(info, c.name, [
          // The date goes back exactly as it was shown.
          { kind: 'update', key, values: { [name('name')]: 'uno', [name('born')]: cells[col('born')] } },
          { kind: 'insert', values: { [name('id')]: '2', [name('code')]: 'b', [name('name')]: 'two' } },
        ]),
      );
      expect(counts).toEqual([1, 1]);
      const after = await query(`${select} order by id`);
      expect(after.rows.map((r) => [Number(r[col('id')]), r[col('name')]])).toEqual([[1, 'uno'], [2, 'two']]);
      expect(toCell(after.rows[0][col('born')])).toEqual(cells[col('born')]);
      expect(after.rows[1][col('born')]).toBeNull();

      // A key that matches nothing rolls the whole batch back.
      await expect(
        driver.transaction(
          c.database,
          gridStatements(info, c.name, [
            { kind: 'delete', key: { [name('id')]: 2, [name('code')]: 'b' } },
            { kind: 'update', key: { [name('id')]: 99, [name('code')]: 'z' }, values: { [name('name')]: 'x' } },
          ]),
        ),
      ).rejects.toThrow(/affected 0 rows instead of 1/);
      expect((await query(`${select} order by id`)).rows).toHaveLength(2);

      await driver.transaction(c.database, gridStatements(info, c.name, [{ kind: 'delete', key: { [name('id')]: 2, [name('code')]: 'b' } }]));
      expect((await query(select)).rows).toHaveLength(1);
    });
  });
}
