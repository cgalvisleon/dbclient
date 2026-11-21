import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresFactory } from '../../src/drivers/postgres';
import { sqliteFactory } from '../../src/drivers/sqlite';
import { ConnectionConfig, DriverFactory, SqlDriver } from '../../src/drivers/types';
import { truncateSql } from '../../src/sql/generate';

// Truncate Table on tables of their own: a temporary PostgreSQL schema (with a child table for
// CASCADE) and a temporary SQLite file.
const env = process.env;
const schema = `dbclient_trunc_${Date.now().toString(36)}`;

let hasNodeSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

interface Case {
  name: string;
  enabled: boolean;
  factory: DriverFactory;
  options: ConnectionConfig['options'];
  password?: string;
  database?: string;
  schema?: string;
  setup: string[];
  teardown: string[];
}

const cases: Case[] = [
  {
    name: 'postgres',
    enabled: Boolean(env.DBCLIENT_PG_HOST),
    factory: postgresFactory,
    options: { host: env.DBCLIENT_PG_HOST, port: Number(env.DBCLIENT_PG_PORT || 5432), database: env.DBCLIENT_PG_DATABASE || 'postgres', user: env.DBCLIENT_PG_USER || 'postgres' },
    password: env.DBCLIENT_PG_PASSWORD,
    database: env.DBCLIENT_PG_DATABASE || 'postgres',
    schema,
    setup: [
      `create schema ${schema}`,
      `create table ${schema}.parent (id int primary key)`,
      `create table ${schema}.child (id int primary key, parent_id int references ${schema}.parent(id))`,
      `insert into ${schema}.parent values (1), (2)`,
      `insert into ${schema}.child values (1, 1)`,
    ],
    teardown: [`drop schema if exists ${schema} cascade`],
  },
  {
    name: 'sqlite',
    enabled: hasNodeSqlite,
    factory: sqliteFactory,
    options: { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-trunc-')), 't.db') },
    setup: ['create table parent (id int primary key)', 'insert into parent values (1), (2)'],
    teardown: [],
  },
];

for (const c of cases) {
  describe.skipIf(!c.enabled)(`truncate table: ${c.name}`, () => {
    const driver = c.factory.create({ id: c.name, name: c.name, type: c.factory.type, options: c.options }, { password: c.password }) as SqlDriver;
    const table = (name: string) => (c.schema ? `${c.schema}.${name}` : name);
    const count = async (name: string) => Number((await driver.execute(`select count(*) from ${table(name)}`, { maxRows: 1, database: c.database }))[0].rows[0][0]);
    const truncate = (name: string, cascade = false) =>
      driver.transaction(c.database, [{ sql: truncateSql({ schema: c.schema, name }, c.factory.dialect!, cascade), params: [] }]);

    beforeAll(async () => {
      await driver.connect();
      for (const sql of c.setup) {
        await driver.execute(sql, { maxRows: 1, database: c.database });
      }
    });

    afterAll(async () => {
      for (const sql of c.teardown) {
        await driver.execute(sql, { maxRows: 1, database: c.database }).catch((e) => console.warn(`${c.name} teardown: ${e.message}`));
      }
      await driver.disconnect();
    });

    it.skipIf(c.name !== 'postgres')('refuses a referenced table without CASCADE, empties both with it', async () => {
      await expect(truncate('parent')).rejects.toThrow();
      expect(await count('parent')).toBe(2);
      await truncate('parent', true);
      expect(await count('parent')).toBe(0);
      expect(await count('child')).toBe(0);
    });

    it.skipIf(c.name === 'postgres')('empties the table', async () => {
      await truncate('parent');
      expect(await count('parent')).toBe(0);
    });
  });
}
