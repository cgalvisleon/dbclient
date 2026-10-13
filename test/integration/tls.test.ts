import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mssqlFactory } from '../../src/drivers/mssql';
import { mysqlFactory } from '../../src/drivers/mysql';
import { natsFactory } from '../../src/drivers/nats';
import { oracleFactory } from '../../src/drivers/oracle';
import { postgresFactory } from '../../src/drivers/postgres';
import { redisFactory } from '../../src/drivers/redis';
import { ConnectionConfig, ConnectionSecrets, DriverFactory, KvDriver, SqlDriver } from '../../src/drivers/types';

// SSL/TLS against the throwaway servers of scripts/tls-fixture.sh:
//   eval "$(scripts/tls-fixture.sh start)"
// SQL Server uses the usual container (its own self-signed certificate).
const env = process.env;
const dir = env.DBCLIENT_TLS_DIR ?? '';
const file = (name: string) => path.join(dir, name);
const hostPort = (value = '') => {
  const [host, port] = value.split(':');
  return { host, port: Number(port) };
};
const ca = { sslCa: file('ca.crt') };
const client = { sslCert: file('client.crt'), sslKey: file('client.key') };

async function connects(factory: DriverFactory, options: ConnectionConfig['options'], secrets: ConnectionSecrets): Promise<void> {
  const driver = factory.create({ id: 'tls', name: 'tls', type: factory.type, options }, secrets);
  try {
    await driver.connect();
    if (factory.category === 'sql') {
      const sql = factory.type === 'oracle' ? 'select 1 as one from dual' : 'select 1 as one';
      expect((await (driver as SqlDriver).execute(sql, { maxRows: 1 }))[0].rows).toHaveLength(1);
    } else if (factory.category === 'kv') {
      expect(await (driver as KvDriver).command(0, ['PING'])).toBe('PONG');
    }
  } finally {
    await driver.disconnect().catch(() => undefined);
  }
}

const fails = (factory: DriverFactory, options: ConnectionConfig['options'], secrets: ConnectionSecrets, pattern?: RegExp) =>
  expect(connects(factory, options, secrets)).rejects.toThrow(pattern);

describe.skipIf(!env.DBCLIENT_TLS_DIR)('SSL/TLS (integration)', () => {
  const password = env.DBCLIENT_TLS_PASSWORD;

  it('PostgreSQL: require, verify-full with the CA, client certificate and passphrase', async () => {
    const base = { ...hostPort(env.DBCLIENT_TLS_PG), database: 'postgres', user: 'postgres' };
    await fails(postgresFactory, { ...base, ssl: 'disable' }, { password }, /no encryption|pg_hba/);
    await connects(postgresFactory, { ...base, ssl: 'require' }, { password });
    await connects(postgresFactory, { ...base, ssl: 'verify-full', ...ca }, { password });
    await fails(postgresFactory, { ...base, ssl: 'verify-full' }, { password }, /self.signed|certificate/i);
    await fails(postgresFactory, { ...base, ssl: 'verify-full', ...ca, sslCa: file('missing.crt') }, { password }, /SSL: cannot read the CA certificate/);

    const cert = { ...base, user: 'certuser', ssl: 'verify-full', ...ca };
    await fails(postgresFactory, cert, { password }, /certificate/i);
    await connects(postgresFactory, { ...cert, ...client }, { password });
    await connects(postgresFactory, { ...cert, ...client, sslKey: file('client-encrypted.key') }, { password, sslPassphrase: password });
    await fails(postgresFactory, { ...cert, ...client, sslKey: file('client-encrypted.key') }, { password, sslPassphrase: 'wrong' }, /decrypt|bad/i);
  });

  it('MySQL: secure transport and REQUIRE X509', async () => {
    const base = { ...hostPort(env.DBCLIENT_TLS_MYSQL), user: 'root' };
    await fails(mysqlFactory, { ...base, ssl: 'disable' }, { password }, /secure transport/i);
    await connects(mysqlFactory, { ...base, ssl: 'require' }, { password });
    await connects(mysqlFactory, { ...base, ssl: 'verify-full', ...ca }, { password });
    await fails(mysqlFactory, { ...base, ssl: 'verify-full' }, { password }, /self.signed|certificate/i);
    await fails(mysqlFactory, { ...base, user: 'certuser', ssl: 'verify-full', ...ca }, { password }, /Access denied/);
    await connects(mysqlFactory, { ...base, user: 'certuser', ssl: 'verify-full', ...ca, ...client }, { password });
  });

  it('Redis: TLS with a required client certificate', async () => {
    const base = { ...hostPort(env.DBCLIENT_TLS_REDIS), db: 0 };
    await connects(redisFactory, { ...base, ssl: 'verify-full', ...ca, ...client }, { password });
    await connects(redisFactory, { ...base, ssl: 'require', ...client }, { password });
    await fails(redisFactory, { ...base, ssl: 'verify-full', ...ca }, { password });
    await fails(redisFactory, { ...base, ssl: 'verify-full', ...client }, { password });
  }, 30000);

  it('NATS: TLS with client certificate verification', async () => {
    const servers = `nats://${env.DBCLIENT_TLS_NATS}`;
    await connects(natsFactory, { servers, auth: 'none', ssl: 'verify-full', ...ca, ...client }, {});
    await fails(natsFactory, { servers, auth: 'none', ssl: 'verify-full', ...ca }, {});
    await fails(natsFactory, { servers, auth: 'none', ssl: 'verify-full', ...client }, {});
  }, 30000);

  it.skipIf(!env.DBCLIENT_ORACLE_HOST)('Oracle: TCPS through a TLS proxy, checking the certificate', async () => {
    const base = {
      ...hostPort(env.DBCLIENT_TLS_ORACLE),
      service: env.DBCLIENT_ORACLE_SERVICE || 'FREEPDB1',
      user: env.DBCLIENT_ORACLE_USER,
    };
    const secrets = { password: env.DBCLIENT_ORACLE_PASSWORD };
    await connects(oracleFactory, { ...base, ssl: 'verify-full', ...ca, ...client }, secrets);
    await connects(oracleFactory, { ...base, ssl: 'require', ...ca, ...client }, secrets);
    await connects(oracleFactory, { ...base, ssl: 'verify-full', ...ca, ...client, sslKey: file('client-encrypted.key') }, { ...secrets, sslPassphrase: env.DBCLIENT_TLS_PASSWORD });
    // System CAs only: the test CA is unknown.
    await fails(oracleFactory, { ...base, ssl: 'verify-full' }, secrets, /NJS-50|certificate/i);
    await fails(oracleFactory, { ...base, ssl: 'verify-full', ...ca }, secrets, /only together with a client certificate and key/);
  }, 60000);

  it.skipIf(!env.DBCLIENT_MSSQL_HOST)('SQL Server: encryption with and without checking its self-signed certificate', async () => {
    const base = { host: env.DBCLIENT_MSSQL_HOST, port: Number(env.DBCLIENT_MSSQL_PORT || 1433), user: env.DBCLIENT_MSSQL_USER || 'sa', database: 'master', encrypt: true };
    const secrets = { password: env.DBCLIENT_MSSQL_PASSWORD };
    await connects(mssqlFactory, { ...base, trustServerCertificate: true }, secrets);
    await fails(mssqlFactory, { ...base, trustServerCertificate: false }, secrets, /self.signed|certificate/i);
  }, 30000);
});
