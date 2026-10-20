import { describe, expect, it } from 'vitest';
import { TableInfo } from '../../src/drivers/types';
import { editMapping, resultColumnMapping } from '../../src/sql/editable';
import {
  canCascade,
  createTableSql,
  deleteTemplate,
  dropSql,
  gridStatements,
  insertTemplate,
  openDataSql,
  rowSql,
  selectTemplate,
  sqlLiteral,
  structureTables,
  updateTemplate,
} from '../../src/sql/generate';
import { placeholder, qualifiedName, quoteIdent } from '../../src/sql/identifiers';
import { completionContext, singleTableSelect, tableReferences, tokenize } from '../../src/sql/parse';

const items: TableInfo = {
  ref: { schema: 'public', name: 'items' },
  kind: 'table',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true, default: "nextval('items_id_seq'::regclass)" },
    { name: 'name', type: 'varchar(50)', nullable: false, primaryKey: false },
    { name: 'active', type: 'boolean', nullable: true, primaryKey: false },
    { name: 'created', type: 'timestamp without time zone', nullable: true, primaryKey: false },
    { name: 'Order', type: 'int', nullable: true, primaryKey: false },
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'items_pkey', columns: ['id'], unique: true, primary: true },
    { name: 'items_name_ix', columns: ['name'], unique: false, primary: false },
  ],
};

describe('identifiers', () => {
  it('quotes only when the dialect needs it', () => {
    expect(quoteIdent('items', 'postgres')).toBe('items');
    expect(quoteIdent('Items', 'postgres')).toBe('"Items"');
    expect(quoteIdent('order', 'postgres')).toBe('"order"');
    expect(quoteIdent('ITEMS', 'oracle')).toBe('ITEMS');
    expect(quoteIdent('items', 'oracle')).toBe('"items"');
    expect(quoteIdent('my col', 'mysql')).toBe('`my col`');
    expect(quoteIdent('a]b', 'mssql')).toBe('[a]]b]');
    expect(quoteIdent('user', 'sqlite')).toBe('"user"');
    expect(qualifiedName({ schema: 'dbo', name: 'Order Lines' }, 'mssql')).toBe('dbo.[Order Lines]');
    expect(qualifiedName({ name: 't' }, 'sqlite')).toBe('t');
  });

  it('numbers placeholders per dialect', () => {
    expect(['postgres', 'mysql', 'mssql', 'oracle', 'sqlite'].map((d) => placeholder(2, d))).toEqual(['$2', '?', '@p2', ':2', '?']);
  });
});

describe('tokenize', () => {
  it('skips comments and keeps strings, quoted names and dollar bodies whole', () => {
    const tokens = tokenize(`select 'a;b', "x y", [z], \`w\` -- c\n/* d */ from $$ body $$ (1)`);
    expect(tokens.map((t) => t.text)).toEqual(['select', "'a;b'", ',', '"x y"', ',', '[z]', ',', '`w`', 'from', '$$ body $$', '(', '1', ')']);
    expect(tokens.find((t) => t.text === '1')?.depth).toBe(1);
  });
});

describe('tableReferences', () => {
  it('finds tables with aliases in FROM lists, joins, UPDATE and INSERT', () => {
    expect(tableReferences('select * from public.items i join orders as o on o.item = i.id, "Users" u where 1 = 1')).toEqual([
      { schema: 'public', name: 'items', alias: 'i', quoted: false },
      { name: 'orders', alias: 'o', quoted: false, schema: undefined },
      { name: 'Users', alias: 'u', quoted: true, schema: undefined },
    ]);
    expect(tableReferences('update items set name = 1').map((r) => [r.name, r.alias])).toEqual([['items', undefined]]);
    expect(tableReferences('insert into dbo.t (a) values (1)').map((r) => [r.schema, r.name])).toEqual([['dbo', 't']]);
    expect(tableReferences('select * from items where id in (select item from orders o)').map((r) => r.name)).toEqual(['items', 'orders']);
    expect(tableReferences('select * from items left join').map((r) => [r.name, r.alias])).toEqual([['items', undefined]]);
    // Commas in function arguments after a subquery are not tables.
    expect(tableReferences('select (select x from t), coalesce(a, b) from u').map((r) => r.name)).toEqual(['t', 'u']);
  });
});

describe('singleTableSelect', () => {
  it('accepts one table with *, plain columns and aliases', () => {
    expect(singleTableSelect('select * from items where id > 1 order by id limit 10')).toEqual({
      table: { name: 'items', schema: undefined, alias: undefined, quoted: false },
      items: [{ star: true }],
    });
    expect(singleTableSelect('SELECT TOP (100) i.id, i.name AS n, upper(name), "Order" FROM dbo.items i')?.items).toEqual([
      { column: 'id', quoted: false },
      { column: 'name', quoted: false },
      null,
      { column: 'Order', quoted: true },
    ]);
    expect(singleTableSelect('select i.* from items i')?.items).toEqual([{ star: true }]);
  });

  it('rejects joins, grouping, DISTINCT, set operations and subqueries in FROM', () => {
    for (const sql of [
      'select * from a join b on a.id = b.id',
      'select * from a, b',
      'select count(*) from a group by x',
      'select distinct x from a',
      'select * from a union select * from b',
      'select * from (select 1) t',
      'with x as (select 1) select * from x',
      'select x.* from a',
      'update a set b = 1',
    ]) {
      expect(singleTableSelect(sql), sql).toBeUndefined();
    }
  });
});

describe('completionContext', () => {
  it('tells tables, columns and members apart', () => {
    expect(completionContext('select * from ', 14)).toEqual({ kind: 'table' });
    expect(completionContext('select * from it', 16)).toEqual({ kind: 'table' });
    expect(completionContext('select * from a, ', 17)).toEqual({ kind: 'table' });
    expect(completionContext('select * from a join ', 21)).toEqual({ kind: 'table' });
    expect(completionContext('select a, ', 10)).toEqual({ kind: 'column' });
    expect(completionContext('select * from items i where i.na', 32)).toEqual({ kind: 'member', qualifier: ['i'] });
    expect(completionContext('select * from public.', 21)).toEqual({ kind: 'member', qualifier: ['public'] });
    expect(completionContext('select * from "My Schema".', 26)).toEqual({ kind: 'member', qualifier: ['My Schema'] });
  });
});

describe('templates', () => {
  it('builds SELECT, INSERT, UPDATE and DELETE from metadata', () => {
    expect(selectTemplate(items, 'postgres')).toBe('SELECT id, name, active, created, "Order"\nFROM public.items;');
    expect(insertTemplate(items, 'postgres')).toBe(
      'INSERT INTO public.items (id, name, active, created, "Order")\nVALUES (0, \'\', FALSE, CURRENT_TIMESTAMP, 0);',
    );
    expect(updateTemplate(items, 'mysql')).toBe(
      "UPDATE public.items\nSET name = '',\n    active = 0,\n    created = CURRENT_TIMESTAMP,\n    `Order` = 0\nWHERE id = 0;",
    );
    expect(deleteTemplate({ ...items, primaryKey: [] }, 'postgres')).toBe(
      'DELETE FROM public.items\n-- No primary key: adjust the condition.\nWHERE id = 0;',
    );
    expect(openDataSql(items, 'mssql')).toBe('SELECT * FROM public.items');
  });

  it('builds structure tabs and a CREATE TABLE', () => {
    const [columns, indexes] = structureTables(items);
    expect(columns.rows[0]).toEqual(['id', 'integer', 'NO', "nextval('items_id_seq'::regclass)", '1']);
    expect(indexes.rows[1]).toEqual(['items_name_ix', 'name', 'NO', 'NO']);
    expect(createTableSql(items, 'postgres')).toBe(
      'CREATE TABLE public.items (\n' +
        "  id integer DEFAULT nextval('items_id_seq'::regclass) NOT NULL,\n" +
        '  name varchar(50) NOT NULL,\n' +
        '  active boolean,\n' +
        '  created timestamp without time zone,\n' +
        '  "Order" int,\n' +
        '  PRIMARY KEY (id)\n' +
        ');\n\n' +
        'CREATE INDEX items_name_ix ON public.items (name);',
    );
  });
});

describe('gridStatements', () => {
  it('generates parameterized DML by primary key', () => {
    const statements = gridStatements(items, 'mssql', [
      { kind: 'update', key: { id: 7 }, values: { name: 'x', active: true, created: '2026-01-02T03:04:05.000Z' } },
      { kind: 'insert', values: { name: 'new' } },
      { kind: 'insert', values: {} },
      { kind: 'delete', key: { id: 8 } },
    ]);
    expect(statements).toEqual([
      {
        sql: 'UPDATE public.items SET name = @p1, active = @p2, created = @p3 WHERE id = @p4',
        params: ['x', 1, '2026-01-02T03:04:05.000Z', 7],
        types: ['varchar(50)', 'boolean', 'timestamp without time zone', 'integer'],
        expect: 1,
      },
      { sql: 'INSERT INTO public.items (name) VALUES (@p1)', params: ['new'], types: ['varchar(50)'], expect: 1 },
      { sql: 'INSERT INTO public.items DEFAULT VALUES', params: [], types: [], expect: 1 },
      { sql: 'DELETE FROM public.items WHERE id = @p1', params: [8], types: ['integer'], expect: 1 },
    ]);
    expect(gridStatements(items, 'postgres', [{ kind: 'update', key: { id: 1 }, values: { active: false } }])[0]).toMatchObject({
      sql: 'UPDATE public.items SET active = $1 WHERE id = $2',
      params: [false, 1],
    });
    expect(gridStatements(items, 'mysql', [{ kind: 'insert', values: {} }])[0].sql).toBe('INSERT INTO public.items () VALUES ()');
  });

  it('refuses to identify rows without a primary key', () => {
    expect(() => gridStatements({ ...items, primaryKey: [] }, 'postgres', [{ kind: 'delete', key: { id: 1 } }])).toThrow(/no primary key/);
    expect(() => gridStatements(items, 'postgres', [{ kind: 'delete', key: {} }])).toThrow(/Missing primary key column id/);
  });
});

describe('editMapping', () => {
  const select = (sql: string) => singleTableSelect(sql)!;

  it('maps * by name and select lists by position', () => {
    expect(editMapping(select('select * from items'), ['id', 'name', 'active', 'created', 'Order'], items)).toEqual({
      columns: ['id', 'name', 'active', 'created', 'Order'],
      key: [0],
    });
    expect(editMapping(select('select name as label, upper(name), ID, name from items'), ['label', 'upper', 'id', 'name'], items)).toEqual({
      columns: ['name', null, 'id', null],
      key: [2],
    });
  });

  it('explains why a result stays read-only', () => {
    expect(editMapping(select('select name from items'), ['name'], items)).toEqual({ reason: 'Include the primary key (id) in the result to edit it.' });
    expect(editMapping(select('select * from items'), ['id'], { ...items, primaryKey: [] })).toEqual({ reason: 'public.items has no primary key.' });
    expect(editMapping(select('select * from items'), ['id'], { ...items, kind: 'view' })).toEqual({ reason: 'public.items is a view.' });
    expect(editMapping(select('select *, name from items'), ['id', 'name'], items)).toEqual({ reason: 'The result columns cannot be matched to the table.' });
  });
});

describe('dropSql', () => {
  it('drops tables and views qualified and quoted per dialect', () => {
    expect(dropSql({ kind: 'table', schema: 'public', name: 'items' }, 'postgres')).toBe('DROP TABLE public.items');
    expect(dropSql({ kind: 'table', schema: 'public', name: 'Items' }, 'postgres', true)).toBe('DROP TABLE public."Items" CASCADE');
    expect(dropSql({ kind: 'materialized', schema: 'public', name: 'totals' }, 'postgres')).toBe('DROP MATERIALIZED VIEW public.totals');
    expect(dropSql({ kind: 'view', schema: 'dbo', name: 'my view' }, 'mssql')).toBe('DROP VIEW dbo.[my view]');
    expect(dropSql({ kind: 'table', name: 'items' }, 'mysql', true)).toBe('DROP TABLE items');
    expect(dropSql({ kind: 'table', schema: 'JSQL', name: 'ITEMS' }, 'oracle', true)).toBe('DROP TABLE JSQL.ITEMS CASCADE CONSTRAINTS');
    expect(dropSql({ kind: 'table', name: 'order' }, 'sqlite')).toBe('DROP TABLE "order"');
  });

  it('drops schemas with each engine\'s statement', () => {
    expect(dropSql({ kind: 'schema', name: 'sales' }, 'postgres', true)).toBe('DROP SCHEMA sales CASCADE');
    expect(dropSql({ kind: 'schema', name: 'sales' }, 'mssql', true)).toBe('DROP SCHEMA sales');
    expect(dropSql({ kind: 'schema', name: 'shop-db' }, 'mysql')).toBe('DROP DATABASE `shop-db`');
    expect(dropSql({ kind: 'schema', name: 'APP' }, 'oracle', true)).toBe('DROP USER APP CASCADE');
    expect(() => dropSql({ kind: 'schema', name: 'main' }, 'sqlite')).toThrow();
  });

  it('offers CASCADE only where the engine has it', () => {
    expect(canCascade({ kind: 'table', name: 't' }, 'postgres')).toBe(true);
    expect(canCascade({ kind: 'table', name: 't' }, 'mysql')).toBe(false);
    expect(canCascade({ kind: 'schema', name: 's' }, 'mssql')).toBe(false);
    expect(canCascade({ kind: 'materialized', name: 'm' }, 'oracle')).toBe(false);
  });
});

describe('row SQL', () => {
  const row = { id: 7, name: "O'Brien", active: true, created: '2026-10-20T08:30:00.000Z', Order: null };

  it('writes literals per dialect', () => {
    expect(sqlLiteral(null, 'text', 'postgres')).toBe('NULL');
    expect(sqlLiteral(true, 'boolean', 'postgres')).toBe('TRUE');
    expect(sqlLiteral(false, 'bit', 'mssql')).toBe('0');
    expect(sqlLiteral('12345678901234567890', 'bigint', 'postgres')).toBe('12345678901234567890');
    expect(sqlLiteral('12', 'varchar(5)', 'postgres')).toBe("'12'");
    expect(sqlLiteral("it's", 'text', 'sqlite')).toBe("'it''s'");
    expect(sqlLiteral('a\\b', 'varchar', 'mysql')).toBe("'a\\\\b'");
    expect(sqlLiteral('año', 'nvarchar', 'mssql')).toBe("N'año'");
    expect(sqlLiteral('2026-10-20T08:30:00.000Z', 'DATE', 'oracle')).toBe("TIMESTAMP '2026-10-20 08:30:00.000'");
    expect(sqlLiteral('2026-10-20T08:30:00.000Z', 'datetime2', 'mssql')).toBe("'2026-10-20T08:30:00.000Z'");
  });

  it('builds INSERT, UPDATE and DELETE by primary key', () => {
    expect(rowSql('insert', items, 'postgres', row)).toBe(
      `INSERT INTO public.items (id, name, active, created, "Order")\nVALUES (7, 'O''Brien', TRUE, '2026-10-20T08:30:00.000Z', NULL);`,
    );
    expect(rowSql('update', items, 'mysql', row)).toBe(
      "UPDATE public.items\nSET name = 'O''Brien',\n    active = 1,\n    created = '2026-10-20T08:30:00.000Z',\n    `Order` = NULL\nWHERE id = 7;",
    );
    expect(rowSql('delete', items, 'mssql', row)).toBe('DELETE FROM public.items\nWHERE id = 7;');
  });

  it('matches every column when the key is not in the row', () => {
    expect(rowSql('delete', items, 'postgres', { name: 'a', Order: null })).toBe(
      'DELETE FROM public.items\n-- No primary key in the result: the condition uses every column; check that it matches one row.\nWHERE name = \'a\'\n  AND "Order" IS NULL;',
    );
    expect(rowSql('update', { ...items, primaryKey: [] }, 'sqlite', { id: 1, name: 'a' })).toContain("SET id = 1,\n    name = 'a'\n-- No primary key");
  });

  it('maps result columns even when the grid is read-only', () => {
    const select = singleTableSelect('select name, upper(name), name from items')!;
    expect(editMapping(select, ['name', 'upper', 'name'], items)).toHaveProperty('reason');
    expect(resultColumnMapping(select, ['name', 'upper', 'name'], items)).toEqual(['name', null, null]);
    expect(resultColumnMapping(singleTableSelect('select *, 1 from items')!, ['id', 'x'], items)).toBeUndefined();
  });
});
