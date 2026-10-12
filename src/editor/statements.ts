// Splits SQL text into statements on `;`, skipping semicolons inside strings, quoted
// identifiers, comments and Postgres dollar-quoted bodies. Offsets are into the original
// text so results and errors can be mapped back to the editor.

export interface Statement {
  text: string;
  /** Offset of the first character of `text`. */
  start: number;
  /** Offset just past the last character of `text` (before the `;`, if any). */
  end: number;
  /** Offset just past the terminating `;`, or `end` when there is none. */
  terminatorEnd: number;
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let segmentStart = 0;
  let hasCode = false;
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
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Postgres allows nested block comments.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === ';') {
      flush(i, i + 1);
      i++;
      continue;
    }
    if (!/\s/.test(ch)) {
      hasCode = true;
    }
    if (ch === "'") {
      // E'...' strings accept backslash escapes; '' is an escaped quote everywhere.
      const backslash = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/\w/.test(sql[i - 2]));
      i = skipQuoted(sql, i, "'", backslash);
      continue;
    }
    if (ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch, false);
      continue;
    }
    if (ch === '[') {
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
 * The statement the caret belongs to: the one containing it (including its `;`), otherwise
 * the closest one before it on the same or previous lines, otherwise the next one.
 */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  const inside = statements.find((s) => offset >= s.start && offset <= s.terminatorEnd);
  if (inside) {
    return inside;
  }
  const before = [...statements].reverse().find((s) => s.terminatorEnd <= offset);
  return before ?? statements.find((s) => s.start >= offset);
}
