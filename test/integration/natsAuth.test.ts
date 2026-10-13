import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { NatsDriver } from '../../src/drivers/nats';
import { ConnectionConfig, ConnectionSecrets, PubSubMessage } from '../../src/drivers/types';

// Runs against the throwaway servers of scripts/nats-auth-fixture.sh (one per auth mode):
//   eval "$(scripts/nats-auth-fixture.sh start)"
const env = process.env;
const run = Date.now().toString(36);

async function roundTrip(options: ConnectionConfig['options'], secrets: ConnectionSecrets): Promise<void> {
  const driver = new NatsDriver({ id: 'auth', name: 'auth', type: 'nats', options }, secrets);
  await driver.connect();
  try {
    const got: PubSubMessage[] = [];
    driver.subscribe(`auth.${run}.>`, undefined, (m) => got.push(m));
    await driver.publish(`auth.${run}.ping`, 'hello');
    const start = Date.now();
    while (!got.length && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(got[0]?.data).toBe('hello');
  } finally {
    await driver.disconnect();
  }
}

const rejects = (options: ConnectionConfig['options'], secrets: ConnectionSecrets) =>
  expect(new NatsDriver({ id: 'auth', name: 'auth', type: 'nats', options }, secrets).connect()).rejects.toThrow();

describe.skipIf(!env.DBCLIENT_NATS_AUTH_USERS_SERVERS)('NatsDriver authentication (integration)', () => {
  const users = { servers: env.DBCLIENT_NATS_AUTH_USERS_SERVERS };

  it('connects with user/password and rejects a wrong password or no auth', async () => {
    await roundTrip({ ...users, auth: 'user/password', user: env.DBCLIENT_NATS_AUTH_USER }, { password: env.DBCLIENT_NATS_AUTH_PASSWORD });
    await rejects({ ...users, auth: 'user/password', user: env.DBCLIENT_NATS_AUTH_USER }, { password: 'wrong' });
    await rejects({ ...users, auth: 'none' }, {});
  });

  it('connects with an nkey seed, even pasted with surrounding whitespace', async () => {
    await roundTrip({ ...users, auth: 'nkey' }, { seed: `  ${env.DBCLIENT_NATS_AUTH_SEED}\n` });
    await expect(new NatsDriver({ id: 'auth', name: 'auth', type: 'nats', options: { ...users, auth: 'nkey' } }, { seed: 'SUnotaseed' }).connect()).rejects.toThrow(/Invalid NKey seed/);
  });

  it('connects with a token and rejects a wrong one', async () => {
    const servers = env.DBCLIENT_NATS_AUTH_TOKEN_SERVERS;
    await roundTrip({ servers, auth: 'token' }, { token: env.DBCLIENT_NATS_AUTH_TOKEN });
    await rejects({ servers, auth: 'token' }, { token: 'wrong' });
  });

  it('connects with a credentials file, also given with ~', async () => {
    const servers = env.DBCLIENT_NATS_AUTH_CREDS_SERVERS;
    const file = env.DBCLIENT_NATS_AUTH_CREDS_FILE!;
    await roundTrip({ servers, auth: 'credentials file', credsFile: file }, {});
    const home = os.homedir();
    if (file.startsWith(home + path.sep)) {
      await roundTrip({ servers, auth: 'credentials file', credsFile: `~${file.slice(home.length)}` }, {});
    }
    await rejects({ servers, auth: 'none' }, {});
    await expect(
      new NatsDriver({ id: 'auth', name: 'auth', type: 'nats', options: { servers, auth: 'credentials file', credsFile: '/nope/x.creds' } }, {}).connect(),
    ).rejects.toThrow(/Credentials file not found: \/nope\/x\.creds/);
  });
});
