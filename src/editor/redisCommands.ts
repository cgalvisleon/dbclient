// Parsing of `.redis` editor lines and shaping of replies for the results grid. No vscode imports.

export interface CommandLine {
  args: string[];
  /** Offset of the line in the document. */
  start: number;
  end: number;
  text: string;
}

/** Splits a redis-cli style line into arguments: whitespace separated, with "double" (escapes) and 'single' quotes. */
export function parseArgs(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) {
      i++;
    }
    if (i >= line.length) {
      break;
    }
    let arg = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i];
      if (ch === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) {
            const next = line[i + 1];
            arg += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
            i += 2;
          } else {
            arg += line[i++];
          }
        }
        if (i >= line.length) {
          throw new Error('Unbalanced double quotes');
        }
        i++;
      } else if (ch === "'") {
        const close = line.indexOf("'", i + 1);
        if (close < 0) {
          throw new Error('Unbalanced single quotes');
        }
        arg += line.slice(i + 1, close);
        i = close + 1;
      } else {
        arg += ch;
        i++;
      }
    }
    args.push(arg);
  }
  return args;
}

/** Non-empty, non-comment (`#` or `//`) lines of `text`, with document offsets relative to `base`. */
export function commandLines(text: string, base = 0): CommandLine[] {
  const lines: CommandLine[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
      const lead = raw.length - raw.trimStart().length;
      lines.push({ args: parseArgs(trimmed), start: base + offset + lead, end: base + offset + lead + trimmed.length, text: trimmed });
    }
    offset += raw.length + 1;
  }
  return lines;
}

export interface ReplyTable {
  columns: string[];
  rows: unknown[][];
}

const PAIR_COMMANDS = new Set(['HGETALL', 'CONFIG GET']);

/** Turns a Redis reply into grid rows: scalars → one cell, arrays → one row each, field/value replies → two columns. */
export function replyTable(args: string[], reply: unknown): ReplyTable {
  const name = args[0]?.toUpperCase() ?? '';
  const full = `${name} ${args[1]?.toUpperCase() ?? ''}`.trim();
  const withScores = args.some((a) => a.toUpperCase() === 'WITHSCORES');

  if (!Array.isArray(reply)) {
    if (typeof reply === 'string' && reply.includes('\n') && (name === 'INFO' || full === 'CLIENT LIST')) {
      return infoTable(reply);
    }
    return { columns: ['value'], rows: [[reply ?? null]] };
  }
  if ((PAIR_COMMANDS.has(name) || PAIR_COMMANDS.has(full)) && reply.length % 2 === 0) {
    return { columns: ['field', 'value'], rows: pairs(reply) };
  }
  if (withScores && reply.length % 2 === 0) {
    return { columns: ['member', 'score'], rows: pairs(reply) };
  }
  if (name === 'SCAN' || name === 'HSCAN' || name === 'SSCAN' || name === 'ZSCAN') {
    const [cursor, items] = reply as [string, unknown[]];
    const rows = name === 'HSCAN' || name === 'ZSCAN' ? pairs(items) : items.map((v) => [v]);
    const columns = name === 'HSCAN' ? ['field', 'value'] : name === 'ZSCAN' ? ['member', 'score'] : ['value'];
    return { columns: [...columns, `next cursor: ${cursor}`], rows: rows.map((r) => [...r, null]) };
  }
  if (name === 'XRANGE' || name === 'XREVRANGE') {
    return {
      columns: ['id', 'fields'],
      rows: (reply as [string, string[]][]).map(([id, fields]) => [id, JSON.stringify(Object.fromEntries(pairs(fields)))]),
    };
  }
  return {
    columns: ['#', 'value'],
    rows: reply.map((v, i) => [i + 1, Array.isArray(v) ? JSON.stringify(v) : (v ?? null)]),
  };
}

function pairs(items: unknown[]): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    rows.push([items[i], items[i + 1]]);
  }
  return rows;
}

function infoTable(text: string): ReplyTable {
  const rows: unknown[][] = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      section = line.slice(1).trim();
    } else if (line.includes(':')) {
      const at = line.indexOf(':');
      rows.push([section, line.slice(0, at), line.slice(at + 1)]);
    } else if (line.trim()) {
      rows.push([section, '', line]);
    }
  }
  return { columns: ['section', 'name', 'value'], rows };
}
