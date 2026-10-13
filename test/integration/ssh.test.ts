import * as net from 'net';
import { describe, expect, it } from 'vitest';
import { mysqlFactory } from '../../src/drivers/mysql';
import { natsFactory } from '../../src/drivers/nats';
import { postgresFactory } from '../../src/drivers/postgres';
import { redisFactory } from '../../src/drivers/redis';
import { connectDriver, openTunnel } from '../../src/drivers/sshTunnel';
import { ConnectionConfig, ConnectionSecrets, DriverFactory, KvDriver, PubSubDriver, SqlDriver } from '../../src/drivers/types';

// SSH tunnels through the throwaway server of scripts/ssh-fixture.sh to the usual local
// containers (seen from the SSH server as DBCLIENT_SSH_TARGET_HOST):
//   eval "$(scripts/ssh-fixture.sh start)"
const env = process.env;
const target = env.DBCLIENT_SSH_TARGET_HOST ?? 'host.docker.internal';
const ssh = { sshHost: env.DBCLIENT_SSH_HOST, sshPort: Number(env.DBCLIENT_SSH_PORT), sshUser: env.DBCLIENT_SSH_USER };
const byPassword = { ...ssh, ssh: 'password' };
const byKey = { ...ssh, ssh: 'private key', sshKeyFile: env.DBCLIENT_SSH_KEY };
const byProtectedKey = { ...ssh, ssh: 'private key', sshKeyFile: env.DBCLIENT_SSH_PROTECTED_KEY };

async function check(factory: DriverFactory, options: ConnectionConfig['options'], secrets: ConnectionSecrets): Promise<void> {
  const driver = await connectDriver(factory, { id: 'ssh', name: 'ssh', type: factory.type, options }, secrets);
  try {
    if (factory.category === 'sql') {
      expect((await (driver as SqlDriver).execute('select 1 as one', { maxRows: 1 }))[0].rows.flat().map(Number)).toEqual([1]);
    } else if (factory.category === 'kv') {
      expect(await (driver as KvDriver).command(15, ['PING'])).toBe('PONG');
    } else {
      const reply = (driver as PubSubDriver).subscribe('dbclient.ssh.test', undefined, () => undefined);
      expect(reply.id).toBeGreaterThan(0);
    }
  } finally {
    await driver.disconnect();
  }
}

describe.skipIf(!env.DBCLIENT_SSH_HOST)('SSH tunnel (integration)', () => {
  it('reaches PostgreSQL with a password, Redis with a key and NATS with a protected key', async () => {
    await check(
      postgresFactory,
      { host: target, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER, ...byPassword },
      { password: env.DBCLIENT_PG_PASSWORD, sshPassword: env.DBCLIENT_SSH_PASSWORD },
    );
    await check(redisFactory, { host: target, port: 6379, db: 15, ...byKey }, { password: env.DBCLIENT_REDIS_PASSWORD });
    await check(natsFactory, { servers: `nats://${target}:4222`, auth: 'none', ...byProtectedKey }, { sshPassphrase: env.DBCLIENT_SSH_PASSPHRASE });
  }, 60000);

  it.skipIf(!env.DBCLIENT_MYSQL_HOST)('reaches MySQL, checking the SSH host key', async () => {
    await check(
      mysqlFactory,
      { host: target, port: 3306, user: env.DBCLIENT_MYSQL_USER || 'root', ...byKey, sshHostKey: env.DBCLIENT_SSH_HOSTKEY },
      { password: env.DBCLIENT_MYSQL_PASSWORD },
    );
  }, 60000);

  it('refuses a wrong password, a wrong passphrase and an unexpected host key', async () => {
    const pg = { host: target, port: 5432, database: env.DBCLIENT_PG_DATABASE, user: env.DBCLIENT_PG_USER };
    await expect(check(postgresFactory, { ...pg, ...byPassword }, { sshPassword: 'wrong' })).rejects.toThrow(/^SSH: .*authentication/i);
    await expect(check(postgresFactory, { ...pg, ...byProtectedKey }, { sshPassphrase: 'wrong' })).rejects.toThrow(/SSH|passphrase|decrypt/i);
    await expect(check(postgresFactory, { ...pg, ...byKey, sshKeyFile: '/nope/id' }, {})).rejects.toThrow(/SSH: cannot read the private key \/nope\/id/);
    const wrong = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await expect(check(postgresFactory, { ...pg, ...byKey, sshHostKey: wrong }, {})).rejects.toThrow(
      new RegExp(`host key is ${env.DBCLIENT_SSH_HOSTKEY!.replace(/[+/]/g, '\\$&')}, not the expected`),
    );
  }, 60000);

  it('closes the local port with the tunnel', async () => {
    const tunnel = await openTunnel(byKey, {}, { host: target, port: 5432 });
    const reachable = (port: number) =>
      new Promise<boolean>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => (socket.destroy(), resolve(true)));
        socket.on('error', () => resolve(false));
      });
    expect(await reachable(tunnel.localPort)).toBe(true);
    await tunnel.close();
    expect(await reachable(tunnel.localPort)).toBe(false);
  }, 30000);
});
