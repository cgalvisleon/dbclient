import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDriver } from '../../src/drivers/redis';

// Runs against DBCLIENT_REDIS_HOST/_PORT/_PASSWORD. Uses db 15 and a unique prefix, and
// only deletes the keys it created.
const env = process.env;
const DB = 15;
const prefix = `dbclient:it:${Date.now().toString(36)}:`;

describe.skipIf(!env.DBCLIENT_REDIS_HOST)('RedisDriver (integration)', () => {
  const driver = new RedisDriver(
    { id: 'it', name: 'it', type: 'redis', options: { host: env.DBCLIENT_REDIS_HOST, port: Number(env.DBCLIENT_REDIS_PORT || 6379), db: DB } },
    { password: env.DBCLIENT_REDIS_PASSWORD },
  );
  const cmd = (...args: (string | number)[]) => driver.command(DB, args);

  beforeAll(async () => {
    await driver.connect();
    await cmd('SET', `${prefix}str`, 'hello');
    await cmd('HSET', `${prefix}user:1`, 'name', 'Ana', 'age', '30');
    await cmd('RPUSH', `${prefix}user:2`, 'a', 'b');
    await cmd('SADD', `${prefix}tags`, 'x', 'y');
    await cmd('ZADD', `${prefix}rank`, '1', 'm1', '2', 'm2');
    await cmd('XADD', `${prefix}events`, '*', 'kind', 'login');
  });

  afterAll(async () => {
    const { keys } = await driver.scan(DB, `${prefix}*`, 1000);
    if (keys.length) {
      await cmd('DEL', ...keys);
    }
    await driver.disconnect();
  });

  it('runs raw commands with the engine reply shape', async () => {
    expect(await cmd('GET', `${prefix}str`)).toBe('hello');
    expect(await cmd('HGETALL', `${prefix}user:1`)).toEqual(['name', 'Ana', 'age', '30']);
    expect(await cmd('TYPE', `${prefix}rank`)).toBe('zset');
    await expect(cmd('NOPE')).rejects.toThrow(/unknown command/i);
  });

  it('scans by pattern', async () => {
    const { keys, complete } = await driver.scan(DB, `${prefix}user:*`, 100);
    expect(keys.sort()).toEqual([`${prefix}user:1`, `${prefix}user:2`]);
    expect(complete).toBe(true);
  });

  it('lists the db and groups keys by separator with their types', async () => {
    const dbs = await driver.children();
    const db = dbs.find((d) => d.label === `db${DB}`)!;
    expect(db.description).toMatch(/keys · default/);

    // Walk dbclient: > it: > <run>: down to our keys.
    let level = await driver.children(db);
    for (const segment of prefix.split(':').filter(Boolean)) {
      const folder = level.find((n) => n.kind === 'folder' && n.label === `${segment}:`);
      expect(folder, `${segment}: in ${level.map((n) => n.label).join(', ')}`).toBeDefined();
      level = await driver.children(folder!);
    }
    const byLabel = Object.fromEntries(level.map((n) => [n.label, n]));
    expect(byLabel['user:'].kind).toBe('folder');
    expect(byLabel['user:'].description).toBe('2');
    expect(byLabel.str.description).toBe('string');
    expect(byLabel.tags.description).toBe('set');
    expect(byLabel.events.description).toBe('stream');
    expect(byLabel.str.meta).toEqual({ db: String(DB), key: `${prefix}str` });

    const users = await driver.children(byLabel['user:']);
    expect(users.map((n) => `${n.label}:${n.description}`)).toEqual(['1:hash', '2:list']);
  });
});
