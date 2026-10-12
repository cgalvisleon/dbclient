import { ansi } from './ansi';
import { postgres } from './postgres';
import { Dialect } from './types';

export type { Dialect, DialectFunction } from './types';

const dialects = new Map<string, Dialect>([[postgres.id, postgres]]);

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
