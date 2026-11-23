import { describe, expect, it } from 'vitest';
import { diskUsageSql, supportsDiskUsage } from '../../src/sql/diskUsage';

describe('diskUsageSql', () => {
  it('covers the targets each engine can measure', () => {
    expect(supportsDiskUsage('server', 'sqlite')).toBe(true);
    expect(supportsDiskUsage('table', 'sqlite')).toBe(false);
    expect(supportsDiskUsage('server', 'oracle')).toBe(false);
    expect(supportsDiskUsage('schema', 'mysql')).toBe(false);
    expect(diskUsageSql({ kind: 'table', name: 't' }, 'sqlite')).toBeUndefined();
  });

  it('gives a total then the tables for a database', () => {
    for (const dialect of ['postgres', 'mysql', 'mssql']) {
      const sql = diskUsageSql({ kind: 'database', database: 'shop' }, dialect)!;
      expect(sql.split(';\n\n')).toHaveLength(2);
      expect(sql).toMatch(/total_mb/);
    }
  });

  it('escapes names as literals', () => {
    expect(diskUsageSql({ kind: 'table', schema: "o'neil", name: 't' }, 'postgres')).toContain("n.nspname = 'o''neil'");
    expect(diskUsageSql({ kind: 'table', database: 'a\\b', name: 't' }, 'mysql')).toContain("table_schema = 'a\\\\b'");
    expect(diskUsageSql({ kind: 'table', schema: 'dbo', name: 'ñ' }, 'mssql')).toContain("t.name = N'ñ'");
  });

  it('reads USER_* views for the own Oracle schema and DBA_* for others', () => {
    const own = diskUsageSql({ kind: 'schema', schema: 'APP' }, 'oracle', { currentUser: 'app' })!;
    expect(own).toContain('FROM user_segments');
    expect(own).not.toMatch(/dba_|owner =/);
    const other = diskUsageSql({ kind: 'table', schema: 'HR', name: 'EMP' }, 'oracle', { currentUser: 'app' })!;
    expect(other).toContain('FROM dba_tables t');
    expect(other).toContain("t.owner = 'HR' AND t.table_name = 'EMP'");
  });
});

describe('diskUsageSql in the editor', () => {
  it('splits into one statement per result for every dialect', async () => {
    const { splitStatements } = await import('../../src/editor/statements');
    const cases: [Parameters<typeof diskUsageSql>[0], string, number][] = [
      [{ kind: 'database', database: 'd' }, 'postgres', 2],
      [{ kind: 'database', database: 'd' }, 'mysql', 2],
      [{ kind: 'database', database: 'd' }, 'mssql', 2],
      [{ kind: 'schema', schema: 'S' }, 'oracle', 2],
      [{ kind: 'table', schema: 'S', name: 'T' }, 'oracle', 1],
      [{ kind: 'server' }, 'sqlite', 1],
    ];
    for (const [target, dialect, count] of cases) {
      expect(splitStatements(diskUsageSql(target, dialect)!, dialect), dialect).toHaveLength(count);
    }
  });
});
