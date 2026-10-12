import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt } from '../../src/editor/statements';

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

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
