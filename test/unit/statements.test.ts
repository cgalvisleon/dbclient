import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt } from '../../src/editor/statements';

const texts = (sql: string, dialect?: string) => splitStatements(sql, dialect).map((s) => s.text);

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('select 1;\n  select 2 ;select 3')).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('keeps offsets pointing into the original text', () => {
    const sql = 'select 1;\n\n  update t set a = 1;';
    for (const s of splitStatements(sql)) {
      expect(sql.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('ignores semicolons in strings, identifiers and comments', () => {
    const sql = [
      "select 'a;b', 'it''s;' from \"x;y\";",
      "-- comment; here\nselect 2 /* block; /* nested; */ still */;",
      "select E'esc\\';aped';",
      'select `m;y` from [ms;sql];',
    ].join('\n');
    expect(texts(sql)).toEqual([
      "select 'a;b', 'it''s;' from \"x;y\"",
      '-- comment; here\nselect 2 /* block; /* nested; */ still */',
      "select E'esc\\';aped'",
      'select `m;y` from [ms;sql]',
    ]);
  });

  it('handles dollar-quoted bodies but not positional parameters', () => {
    const fn = 'create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql';
    expect(texts(`${fn};\nselect $$a;b$$;\nselect $1;select 2`)).toEqual([fn, 'select $$a;b$$', 'select $1', 'select 2']);
  });

  it('drops empty and comment-only segments', () => {
    expect(texts(';;\n-- only a comment\n;  ;select 1;')).toEqual(['select 1']);
  });
});

describe('dialect rules', () => {
  it('mssql: GO separates batches and procedure bodies keep their semicolons', () => {
    const proc = 'create procedure p as\nbegin\n  select 1;\n  select 2;\nend';
    expect(texts(`select 1; select 2\nGO\n${proc}\ngo\nexec p;`, 'mssql')).toEqual(['select 1', 'select 2', proc, 'exec p']);
    expect(texts('create or alter view v as select 1 as a;\nselect 2;', 'mssql')).toEqual(['create or alter view v as select 1 as a;\nselect 2;']);
  });

  it('mysql: DELIMITER directives and BEGIN...END bodies', () => {
    const body = 'create procedure p()\nbegin\n  if 1 then select 1; end if;\n  select case when 1 then 2 end;\nend';
    expect(texts(`${body};\nselect 3;`, 'mysql')).toEqual([body, 'select 3']);
    expect(texts(`DELIMITER //\n${body}//\nDELIMITER ;\nselect 4;`, 'mysql')).toEqual([body, 'select 4']);
    expect(texts("select 'it\\'s; fine';", 'mysql')).toEqual(["select 'it\\'s; fine'"]);
    expect(texts('create function f() returns int deterministic return 1;\nselect f();', 'mysql')).toEqual([
      'create function f() returns int deterministic return 1',
      'select f()',
    ]);
  });

  it('oracle: PL/SQL blocks end after their END; or at a slash line', () => {
    const proc = 'create or replace procedure p as\n  v number;\nbegin\n  loop exit; end loop;\n  null;\nend p;';
    const anon = 'begin\n  null;\nend;';
    expect(texts(`select 1 from dual;\n${proc}\n${anon}\nselect 2 from dual;`, 'oracle')).toEqual([
      'select 1 from dual',
      proc.slice(0, -1),
      anon.slice(0, -1),
      'select 2 from dual',
    ]);
    const spec = 'create package pk as\n  procedure a;\n  procedure b;\nend pk;';
    expect(texts(`${spec}\nselect 1 from dual;`, 'oracle')).toEqual([spec.slice(0, -1), 'select 1 from dual']);
    const body = 'create package body pk as\n  procedure a is begin null; end a;\n  procedure b is begin null; end b;\nend pk;';
    expect(texts(`${body}\n/\nselect 1 from dual;`, 'oracle')).toEqual([body, 'select 1 from dual']);
    expect(texts(`${body}\nselect 1 from dual;`, 'oracle')).toEqual([body.slice(0, -1), 'select 1 from dual']);
  });

  it('sqlite: triggers keep their inner statements', () => {
    const trg = 'create trigger t after insert on a begin\n  update b set n = n + 1;\n  delete from c;\nend';
    expect(texts(`${trg};\nselect 1;`, 'sqlite')).toEqual([trg, 'select 1']);
  });

  it('postgres: BEGIN is a plain transaction statement and [ is not a quote', () => {
    expect(texts('begin; select a[1]; commit;', 'postgres')).toEqual(['begin', 'select a[1]', 'commit']);
  });
});

describe('statementAt', () => {
  const sql = 'select 1;\nselect 2;\n\nselect 3';
  const statements = splitStatements(sql);

  it('picks the statement containing the caret, including right after its semicolon', () => {
    expect(statementAt(statements, sql.indexOf('2'))?.text).toBe('select 2');
    expect(statementAt(statements, sql.indexOf('2') + 2)?.text).toBe('select 2');
  });

  it('falls back to the previous statement on a blank line', () => {
    expect(statementAt(statements, sql.indexOf('\n\n') + 1)?.text).toBe('select 2');
  });

  it('picks the next statement when the caret is before everything', () => {
    const leading = splitStatements('\n\nselect 9');
    expect(statementAt(leading, 0)?.text).toBe('select 9');
  });
});
