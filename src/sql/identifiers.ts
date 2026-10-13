import { TableRef } from '../drivers/types';

// Identifier quoting and parameter placeholders per dialect. Pure, shared by drivers and the editor.

const RESERVED = new Set(
  `all alter and any as asc between by case check column comment constraint create cross current date default delete desc
   distinct drop else end exists fetch file for foreign from full grant group having in index inner insert intersect into is
   join key left level like limit minus natural not null number of offset on or order outer primary references right row rows
   select session set size table then time timestamp to top trigger type union unique update user using values view when
   where with`
    .split(/\s+/)
    .filter(Boolean),
);

const PLAIN: Record<string, RegExp> = {
  postgres: /^[a-z_][a-z0-9_$]*$/,
  oracle: /^[A-Z][A-Z0-9_$#]*$/,
  mysql: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  mssql: /^[A-Za-z_][A-Za-z0-9_@#$]*$/,
  sqlite: /^[A-Za-z_][A-Za-z0-9_]*$/,
};

/** Quotes an identifier only when the dialect needs it (case, characters or reserved words). */
export function quoteIdent(name: string, dialect: string): string {
  const plain = PLAIN[dialect] ?? PLAIN.sqlite;
  if (plain.test(name) && !RESERVED.has(name.toLowerCase())) {
    return name;
  }
  switch (dialect) {
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``;
    case 'mssql':
      return `[${name.replace(/]/g, ']]')}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/** `schema.name` (schema omitted when absent), quoted as needed. */
export function qualifiedName(ref: TableRef, dialect: string): string {
  return [ref.schema, ref.name]
    .filter((p): p is string => Boolean(p))
    .map((p) => quoteIdent(p, dialect))
    .join('.');
}

/** Placeholder for the 1-based parameter `n`. */
export function placeholder(n: number, dialect: string): string {
  switch (dialect) {
    case 'postgres':
      return `$${n}`;
    case 'mssql':
      return `@p${n}`;
    case 'oracle':
      return `:${n}`;
    default:
      return '?';
  }
}

/** Unquotes an identifier token (`"x"`, `` `x` ``, `[x]`); plain words are returned as typed. */
export function unquoteIdent(token: string): string {
  const first = token[0];
  if (first === '"' && token.endsWith('"')) {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  if (first === '`' && token.endsWith('`')) {
    return token.slice(1, -1).replace(/``/g, '`');
  }
  if (first === '[' && token.endsWith(']')) {
    return token.slice(1, -1).replace(/]]/g, ']');
  }
  return token;
}

/** Whether an identifier token was quoted (then it matches case-sensitively). */
export function isQuotedIdent(token: string): boolean {
  return /^["`[]/.test(token);
}

/** Case-insensitive name match, exact match preferred; quoted names match exactly. */
export function findByName<T>(items: T[], name: string, nameOf: (item: T) => string | undefined, quoted = false): T | undefined {
  return items.find((i) => nameOf(i) === name) ?? (quoted ? undefined : items.find((i) => nameOf(i)?.toLowerCase() === name.toLowerCase()));
}
