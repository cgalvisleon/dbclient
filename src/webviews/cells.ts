/** Converts driver values into what the grid shows and exports (strings, numbers, booleans, null). */
export function toCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `\\x${value.toString('hex')}`;
  }
  return JSON.stringify(value);
}
