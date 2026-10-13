import { isTemporalType } from '../sql/generate';
import { ParamStatement, ParamValue } from './types';

// Helpers for drivers running parameterized statements (grid edits).

/** Throws when a statement did not affect the rows it had to (e.g. a row changed or vanished meanwhile). */
export function checkCount(statement: ParamStatement, count: number): void {
  if (statement.expect !== undefined && count !== statement.expect) {
    throw new Error(
      `${statement.sql.split(/\s+/)[0].toUpperCase()} affected ${count} rows instead of ${statement.expect}; nothing was saved. The row may have been changed or deleted by someone else.`,
    );
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Drivers that read dates as JS Dates show them as ISO instants (`…Z`); those strings go back
 * as Dates into temporal columns so the driver converts them the same way it read them.
 */
export function bindTemporal(value: ParamValue, type: string | undefined): ParamValue | Date {
  return typeof value === 'string' && isTemporalType(type) && ISO_INSTANT.test(value) ? new Date(value) : value;
}
