export interface DialectFunction {
  name: string;
  signature: string;
  doc?: string;
  /** Used without parentheses (CURRENT_DATE, ...). */
  noParens?: boolean;
}

export interface Dialect {
  id: string;
  keywords: string[];
  types: string[];
  functions: DialectFunction[];
}
