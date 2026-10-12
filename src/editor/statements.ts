// Splits SQL text into statements, skipping terminators inside strings, quoted identifiers,
// comments and Postgres dollar-quoted bodies. Offsets are into the original text so results
// and errors can be mapped back to the editor.
//
// Dialect rules on top of `;`:
// - mssql: a line with only `GO` ends a batch; CREATE/ALTER PROCEDURE|FUNCTION|TRIGGER|VIEW
//   runs until the next GO (or the end).
// - mysql: `DELIMITER xx` lines change the terminator; CREATE PROCEDURE|FUNCTION|TRIGGER|EVENT
//   bodies with BEGIN ... END end at the `;` after their closing END.
// - oracle: a line with only `/` ends a PL/SQL block; without it, DECLARE/BEGIN/CREATE
//   PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE blocks end at the `;` after their closing END.
// - sqlite: CREATE TRIGGER ... BEGIN ...; END is kept whole.

export interface Statement {
  text: string;
  /** Offset of the first character of `text`. */
  start: number;
  /** Offset just past the last character of `text` (before the terminator, if any). */
  end: number;
  /** Offset just past the terminator, or `end` when there is none. */
  terminatorEnd: number;
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

type BlockMode = 'none' | 'untilGo' | 'beginEnd';

function blockModeFor(dialect: string | undefined, head: string): { mode: BlockMode; requiresBegin: boolean; packageBody: boolean } {
  const none = { mode: 'none' as BlockMode, requiresBegin: false, packageBody: false };
  switch (dialect) {
    case 'mssql':
      return /^(CREATE\s+OR\s+ALTER|CREATE|ALTER)\s+(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/i.test(head)
        ? { ...none, mode: 'untilGo' }
        : none;
    case 'mysql':
      return /^CREATE\s+(DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(head)
        ? { ...none, mode: 'beginEnd' }
        : none;
    case 'oracle': {
      const m = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE\s+BODY|PACKAGE|TRIGGER|TYPE\s+BODY|TYPE)\b|DECLARE\b|BEGIN\b)/i.exec(head);
      if (!m) {
        return none;
      }
      // A plain `CREATE TYPE x AS OBJECT (...)` has no END at all.
      if (m[1] && /^TYPE$/i.test(m[1]) && !/\bEND\b/i.test(head)) {
        return none;
      }
      return { mode: 'beginEnd', requiresBegin: true, packageBody: Boolean(m[1] && /BODY$/i.test(m[1])) };
    }
    case 'sqlite':
      return /^CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(head) ? { ...none, mode: 'beginEnd' } : none;
    default:
      return none;
  }
}

export function splitStatements(sql: string, dialect?: string): Statement[] {
  const statements: Statement[] = [];
  let segmentStart = 0;
  let hasCode = false;
  let delimiter = ';';
  let block: ReturnType<typeof blockModeFor> = blockModeFor(undefined, '');
  let depth = 0;
  let sawBegin = false;
  let closed = false;
  let i = 0;

  const flush = (end: number, terminatorEnd: number) => {
    if (hasCode) {
      const raw = sql.slice(segmentStart, end);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      statements.push({ text, start: segmentStart + lead, end: segmentStart + lead + text.length, terminatorEnd });
    }
    segmentStart = terminatorEnd;
    hasCode = false;
    block = blockModeFor(undefined, '');
    depth = 0;
    sawBegin = false;
    closed = false;
  };

  const lineEnd = (from: number) => {
    const nl = sql.indexOf('\n', from);
    return nl < 0 ? sql.length : nl + 1;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    const atLineStart = i === 0 || sql[i - 1] === '\n';

    if (atLineStart) {
      const line = sql.slice(i, lineEnd(i));
      if (dialect === 'mssql' && /^[ \t]*GO[ \t]*(--.*)?\r?\n?$/i.test(line)) {
        flush(i, i + line.length);
        i += line.length;
        continue;
      }
      if (dialect === 'oracle' && /^[ \t]*\/[ \t]*\r?\n?$/.test(line)) {
        flush(i, i + line.length);
        i += line.length;
        continue;
      }
      if (dialect === 'mysql' && !hasCode) {
        const m = /^[ \t]*DELIMITER[ \t]+(\S+)/i.exec(line);
        if (m) {
          delimiter = m[1];
          segmentStart = i + line.length;
          i += line.length;
          continue;
        }
      }
    }

    if (ch === '-' && next === '-') {
      i = lineEnd(i);
      continue;
    }
    if (ch === '/' && next === '*') {
      // Postgres allows nested block comments.
      let nesting = 1;
      i += 2;
      while (i < sql.length && nesting > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          nesting++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          nesting--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (sql.startsWith(delimiter, i)) {
      const terminates =
        block.mode === 'none' ||
        (block.mode === 'beginEnd' && (closed || (!sawBegin && !block.requiresBegin)));
      if (terminates) {
        flush(i, i + delimiter.length);
        i += delimiter.length;
        continue;
      }
    }

    if (!/\s/.test(ch) && !hasCode) {
      hasCode = true;
      block = blockModeFor(dialect, sql.slice(i, i + 4000));
      // With an explicit `/` terminator later on, Oracle blocks end there.
      if (dialect === 'oracle' && block.mode === 'beginEnd' && /^[ \t]*\/[ \t]*$/m.test(sql.slice(i))) {
        block = { ...block, mode: 'untilGo' };
      }
    }

    if (/[A-Za-z_]/.test(ch) && !(i > 0 && /[\w$#]/.test(sql[i - 1]))) {
      const word = /^[A-Za-z_][\w$#]*/.exec(sql.slice(i, i + 64))![0];
      if (block.mode === 'beginEnd') {
        const upper = word.toUpperCase();
        if (upper === 'BEGIN' || upper === 'CASE') {
          depth++;
          sawBegin = sawBegin || upper === 'BEGIN';
        } else if (upper === 'END') {
          const following = /^\s*([A-Za-z_]\w*)/.exec(sql.slice(i + 3, i + 40));
          if (!following || !/^(IF|LOOP|WHILE|REPEAT)$/i.test(following[1])) {
            depth--;
            // A package body ends with an END that has no matching BEGIN.
            closed = block.packageBody ? depth < 0 : depth <= 0;
          }
        }
      }
      i += word.length;
      continue;
    }

    if (ch === "'") {
      // E'...' strings accept backslash escapes; '' is an escaped quote everywhere.
      const backslash = (i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/\w/.test(sql[i - 2]))) || dialect === 'mysql';
      i = skipQuoted(sql, i, "'", backslash);
      continue;
    }
    if (ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch, false);
      continue;
    }
    if (ch === '[' && dialect !== 'postgres') {
      const close = sql.indexOf(']', i + 1);
      i = close < 0 ? sql.length : close + 1;
      continue;
    }
    if (ch === '$' && !(i > 0 && /\w/.test(sql[i - 1]))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? sql.length : close + tag[0].length;
        continue;
      }
    }
    i++;
  }
  flush(sql.length, sql.length);
  return statements;
}

function skipQuoted(sql: string, open: number, quote: string, backslashEscapes: boolean): number {
  let i = open + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === '\\') {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * The statement the caret belongs to: the one containing it (including its terminator),
 * otherwise the closest one before it, otherwise the next one.
 */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  const inside = statements.find((s) => offset >= s.start && offset <= s.terminatorEnd);
  if (inside) {
    return inside;
  }
  const before = [...statements].reverse().find((s) => s.terminatorEnd <= offset);
  return before ?? statements.find((s) => s.start >= offset);
}
