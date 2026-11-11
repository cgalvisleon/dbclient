import { describe, expect, it } from 'vitest';
import { allDrivers } from '../../src/drivers/registry';
import { isProduction, sessionLimitMs } from '../../src/drivers/production';
import { ConnectionConfig } from '../../src/drivers/types';

const config = (options: ConnectionConfig['options']): ConnectionConfig => ({ id: 'c', name: 'c', type: 'postgres', options });

describe('production connections', () => {
  it('every engine offers the production fields', () => {
    for (const driver of allDrivers()) {
      const keys = driver.fields.map((f) => f.key);
      expect(keys, driver.type).toContain('production');
      expect(keys, driver.type).toContain('sessionMinutes');
    }
  });

  it('only a checked production flag counts', () => {
    expect(isProduction(config({}))).toBe(false);
    expect(isProduction(config({ production: false }))).toBe(false);
    expect(isProduction(config({ production: true }))).toBe(true);
  });

  it('session limit: default 30 min, 0 = none, ignored when not production', () => {
    expect(sessionLimitMs(config({ sessionMinutes: 5 }))).toBeUndefined();
    expect(sessionLimitMs(config({ production: true }))).toBe(30 * 60_000);
    expect(sessionLimitMs(config({ production: true, sessionMinutes: 5 }))).toBe(5 * 60_000);
    expect(sessionLimitMs(config({ production: true, sessionMinutes: 0 }))).toBeUndefined();
    expect(sessionLimitMs(config({ production: true, sessionMinutes: 'x' }))).toBeUndefined();
  });
});
