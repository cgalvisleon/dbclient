import { isQuotedIdent, unquoteIdent } from './identifiers';

// A small, forgiving SQL reader: enough to find the tables (and aliases) a statement uses, to
// tell whether a SELECT reads a single table, and what the caret is completing. It never
// rejects input; anything it does not understand simply yields fewer facts.

export interface Token {
  type: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  text: string;
  start: number;
  end: number;
  /** Parenthesis depth the token sits at. */
  depth: number;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const push = (type: Token['type'], start: number, end: number, d = depth) =>
    tokens.push({ type, text: sql.slice(start, end), start, end, depth: d });
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? sql.length : close + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      push('string', i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close && sql[j + 1] === close) j += 2;
        else if (sql[j] === close) break;
        else j++;
      }
      push('quoted', i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (c === '$' && /^\$[A-Za-z_]?[\w]*\$/.test(sql.slice(i))) {
      // PostgreSQL dollar quoting: $$...$$ or $tag$...$tag$.
      const tag = /^\$[A-Za-z_]?[\w]*\$/.exec(sql.slice(i))![0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close < 0 ? sql.length : close + tag.length;
      push('string', i, end);
      i = end;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i))!;
      push('number', i, i + m[0].length);
      i += m[0].length;
    } else if (/[A-Za-z_@#À-￿]/.test(c)) {
      const m = /^[A-Za-z_@#À-￿][\w$#@À-￿]*/.exec(sql.slice(i))!;
      push('word', i, i + m[0].length);
      i += m[0].length;
    } else if (c === '(') {
      push('punct', i, i + 1);
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      push('punct', i, i + 1);
      i++;
    } else {
      push('punct', i, i + 1);
      i++;
    }
  }
  return tokens;
}

const lower = (t: Token | undefined) => (t && t.type === 'word' ? t.text.toLowerCase() : undefined);
const isName = (t: Token | undefined) => Boolean(t && (t.type === 'word' || t.type === 'quoted'));

/** Words that end a table reference instead of being its alias. */
const NOT_ALIAS = new Set(
  `where join inner left right full outer cross natural on using group order having limit offset union intersect except
   minus set values select fetch for window with returning lateral pivot unpivot tablesample partition connect start into
   straight_join use force ignore default when then else end go apply as where qualify`.split(/\s+/),
);

const TABLE_KEYWORDS = new Set(['from', 'join', 'update', 'into', 'table']);

export interface TableReference {
  schema?: string;
  name: string;
  alias?: string;
  /** The name was quoted, so it matches case-sensitively. */
  quoted: boolean;
}

/** Reads `name`, `schema.name` or `db.schema.name` at `i`; returns the parts and the next index. */
function readName(tokens: Token[], i: number): { parts: string[]; quoted: boolean; next: number } | undefined {
  if (!isName(tokens[i])) {
    return undefined;
  }
  const parts = [unquoteIdent(tokens[i].text)];
  let quoted = isQuotedIdent(tokens[i].text);
  let j = i + 1;
  while (tokens[j]?.text === '.' && isName(tokens[j + 1])) {
    parts.push(unquoteIdent(tokens[j + 1].text));
    quoted = isQuotedIdent(tokens[j + 1].text);
    j += 2;
  }
  return { parts, quoted, next: j };
}

function readAlias(tokens: Token[], i: number): { alias?: string; next: number } {
  let j = i;
  if (lower(tokens[j]) === 'as') {
    j++;
  }
  const t = tokens[j];
  if (t && (t.type === 'quoted' || (t.type === 'word' && !NOT_ALIAS.has(t.text.toLowerCase())))) {
    return { alias: unquoteIdent(t.text), next: j + 1 };
  }
  return { next: i };
}

function skipGroup(tokens: Token[], i: number): number {
  const depth = tokens[i].depth;
  let j = i + 1;
  while (j < tokens.length && !(tokens[j].text === ')' && tokens[j].depth === depth)) {
    j++;
  }
  return j + 1;
}

/** Words that end a FROM clause at their depth (JOIN, ON and USING stay inside it). */
const CLAUSE_END = new Set(['select', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect', 'except', 'minus', 'set', 'values', 'returning', 'window', 'qualify', 'fetch', 'for', 'connect', 'start']);

/** Reads one table reference (or skips a subquery) at `i`. */
function readReference(tokens: Token[], i: number): TableReference | undefined {
  if (tokens[i]?.text === '(') {
    // A subquery: its own FROM is found by the caller's scan.
    return undefined;
  }
  const name = readName(tokens, i);
  if (!name || (name.parts.length === 1 && tokens[i].type === 'word' && NOT_ALIAS.has(name.parts[0].toLowerCase()))) {
    return undefined;
  }
  return {
    name: name.parts[name.parts.length - 1],
    schema: name.parts.length > 1 ? name.parts[name.parts.length - 2] : undefined,
    alias: readAlias(tokens, name.next).alias,
    quoted: name.quoted,
  };
}

/** Tables referenced after FROM (and its commas), JOIN, UPDATE, INTO and TABLE, at any depth, with their aliases. */
export function tableReferences(sql: string): TableReference[] {
  const tokens = tokenize(sql);
  const refs: TableReference[] = [];
  // Per parenthesis depth: whether the scan is inside a FROM clause.
  const inFrom: boolean[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const word = lower(t);
    if (word && TABLE_KEYWORDS.has(word)) {
      inFrom[t.depth] = word === 'from' || (word === 'join' && inFrom[t.depth]);
      const ref = readReference(tokens, i + 1);
      if (ref) {
        refs.push(ref);
      }
    } else if (word && CLAUSE_END.has(word)) {
      inFrom[t.depth] = false;
    } else if (t.text === '(') {
      // A new group (subquery or function arguments) starts outside any FROM.
      inFrom[t.depth + 1] = false;
    } else if (t.text === ',' && inFrom[t.depth]) {
      const ref = readReference(tokens, i + 1);
      if (ref) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

export type SelectItem = { star: true } | { column: string; quoted: boolean } | null;

export interface SingleTableSelect {
  table: TableReference;
  /** One entry per select-list item: `*`, a plain column, or null for an expression. */
  items: SelectItem[];
}

const NOT_SINGLE = new Set(['union', 'intersect', 'except', 'minus', 'join', 'group', 'having', 'distinct', 'into', 'connect', 'pivot', 'unpivot', 'window', 'apply', 'lateral']);

/**
 * When `sql` is a SELECT over exactly one table (no joins, grouping, DISTINCT or set
 * operations), returns that table and what each select-list item is.
 */
export function singleTableSelect(sql: string): SingleTableSelect | undefined {
  const tokens = tokenize(sql);
  if (lower(tokens[0]) !== 'select') {
    return undefined;
  }
  const top = tokens.filter((t) => t.depth === 0);
  if (top.some((t) => NOT_SINGLE.has(lower(t) ?? ''))) {
    return undefined;
  }
  const fromAt = top.findIndex((t) => lower(t) === 'from');
  if (fromAt < 0) {
    return undefined;
  }
  // FROM <one table> [alias], with no comma list or subquery.
  const fromIndex = tokens.indexOf(top[fromAt]);
  if (tokens[fromIndex + 1]?.text === '(') {
    return undefined;
  }
  const name = readName(tokens, fromIndex + 1);
  if (!name) {
    return undefined;
  }
  const alias = readAlias(tokens, name.next);
  if (tokens[alias.next]?.text === ',') {
    return undefined;
  }
  const table: TableReference = {
    name: name.parts[name.parts.length - 1],
    schema: name.parts.length > 1 ? name.parts[name.parts.length - 2] : undefined,
    alias: alias.alias,
    quoted: name.quoted,
  };

  // Select list: skip ALL and TOP n / TOP (n) [PERCENT].
  let start = 1;
  if (lower(tokens[start]) === 'all') {
    start++;
  }
  if (lower(tokens[start]) === 'top') {
    start = tokens[start + 1]?.text === '(' ? skipGroup(tokens, start + 1) : start + 2;
    if (lower(tokens[start]) === 'percent') {
      start++;
    }
  }
  const list = tokens.slice(start, fromIndex);
  const groups: Token[][] = [[]];
  for (const t of list) {
    if (t.text === ',' && t.depth === 0) {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(t);
    }
  }
  const qualifierOk = (q: Token) => {
    const n = unquoteIdent(q.text).toLowerCase();
    return n === table.name.toLowerCase() || n === table.alias?.toLowerCase();
  };
  const items: SelectItem[] = [];
  for (const g of groups) {
    if (!g.length) {
      return undefined;
    }
    if (g.length === 1 && g[0].text === '*') {
      items.push({ star: true });
      continue;
    }
    if (g.length === 3 && isName(g[0]) && g[1].text === '.' && g[2].text === '*') {
      if (!qualifierOk(g[0])) {
        return undefined;
      }
      items.push({ star: true });
      continue;
    }
    // col | t.col, optionally followed by [AS] alias.
    let k = 0;
    if (isName(g[0]) && g[1]?.text === '.' && isName(g[2])) {
      if (!qualifierOk(g[0])) {
        items.push(null);
        continue;
      }
      k = 2;
    }
    const col = g[k];
    const rest = g.slice(k + 1);
    const aliasOnly =
      rest.length === 0 ||
      (rest.length === 1 && isName(rest[0]) && !NOT_ALIAS.has(lower(rest[0]) ?? '')) ||
      (rest.length === 2 && lower(rest[0]) === 'as' && isName(rest[1]));
    if (isName(col) && aliasOnly && !(col.type === 'word' && ['null', 'true', 'false', 'case'].includes(col.text.toLowerCase()))) {
      items.push({ column: unquoteIdent(col.text), quoted: isQuotedIdent(col.text) });
    } else {
      items.push(null);
    }
  }
  return { table, items };
}

export type CompletionContext =
  | { kind: 'member'; qualifier: string[] }
  | { kind: 'table' }
  | { kind: 'column' };

/** What the caret at `offset` (inside one statement) is completing. */
export function completionContext(sql: string, offset: number): CompletionContext {
  const before = sql.slice(0, offset).replace(/[\w$#@À-￿]*$/, '');
  if (before.endsWith('.')) {
    // Qualifier chain right before the dot: a.b.
    const tokens = tokenize(before.slice(0, -1));
    const parts: string[] = [];
    let i = tokens.length - 1;
    while (i >= 0 && isName(tokens[i])) {
      parts.unshift(unquoteIdent(tokens[i].text));
      if (tokens[i - 1]?.text === '.') {
        i -= 2;
      } else {
        break;
      }
    }
    if (parts.length) {
      return { kind: 'member', qualifier: parts };
    }
  }
  const tokens = tokenize(before);
  const last = tokens[tokens.length - 1];
  if (last && TABLE_KEYWORDS.has(lower(last) ?? '')) {
    return { kind: 'table' };
  }
  if (last?.text === ',') {
    // In a FROM list a comma starts another table.
    for (let i = tokens.length - 2; i >= 0; i--) {
      const t = tokens[i];
      if (t.depth !== last.depth) {
        continue;
      }
      const w = lower(t);
      if (w === 'from') {
        return { kind: 'table' };
      }
      if (w && ['select', 'where', 'set', 'by', 'on', 'values', 'having', 'returning'].includes(w)) {
        break;
      }
    }
  }
  return { kind: 'column' };
}
