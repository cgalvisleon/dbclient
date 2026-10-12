import { ansi } from './ansi';
import { mssql } from './mssql';
import { mysql } from './mysql';
import { oracle } from './oracle';
import { postgres } from './postgres';
import { sqlite } from './sqlite';
import { Dialect } from './types';

export type { Dialect, DialectFunction } from './types';

const dialects = new Map<string, Dialect>([postgres, mysql, mssql, oracle, sqlite].map((d) => [d.id, d]));

/** The ANSI base merged with the engine's own vocabulary; unknown ids get plain ANSI. */
export function resolveDialect(id: string | undefined): Dialect {
  const extra = id ? dialects.get(id) : undefined;
  if (!extra) {
    return ansi;
  }
  const byName = new Map([...ansi.functions, ...extra.functions].map((f) => [f.name, f]));
  return {
    id: extra.id,
    keywords: [...new Set([...ansi.keywords, ...extra.keywords])],
    types: [...new Set([...ansi.types, ...extra.types])],
    functions: [...byName.values()],
  };
}
