import { describe, expect, it } from 'vitest';
import { oracleFactory } from '../../src/drivers/oracle';
import { connectDriver } from '../../src/drivers/sshTunnel';
import { ConnectionConfig, SqlDriver } from '../../src/drivers/types';

// Oracle connections by JDBC URL against the same server as sqlDrivers.test.ts:
//   DBCLIENT_ORACLE_HOST/_PORT/_SERVICE/_USER/_PASSWORD, plus DBCLIENT_ORACLE_SID (default FREE).
const env = process.env;
const host = env.DBCLIENT_ORACLE_HOST;
const port = Number(env.DBCLIENT_ORACLE_PORT || 1521);
const service = env.DBCLIENT_ORACLE_SERVICE || 'FREEPDB1';

async function selectOne(jdbcUrl: string, user = env.DBCLIENT_ORACLE_USER, password = env.DBCLIENT_ORACLE_PASSWORD): Promise<unknown> {
  const options: ConnectionConfig['options'] = { connectBy: 'JDBC URL', jdbcUrl, user };
  const secrets = { password };
  oracleFactory.prepare!(options, secrets);
  const driver = oracleFactory.create({ id: 'jdbc', name: 'jdbc', type: 'oracle', options }, secrets) as SqlDriver;
  try {
    await driver.connect();
    const [result] = await driver.execute('select 1 as one from dual', { maxRows: 1 });
    return result.rows[0][0];
  } finally {
    await driver.disconnect();
  }
}

describe.skipIf(!host)('oracle by JDBC URL', () => {
  it('connects with a service name, with or without //', async () => {
    expect(Number(await selectOne(`jdbc:oracle:thin:@//${host}:${port}/${service}`))).toBe(1);
    expect(Number(await selectOne(`jdbc:oracle:thin:@${host}:${port}/${service}`))).toBe(1);
  }, 30_000);

  it('connects with a descriptor', async () => {
    const url = `jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SERVICE_NAME=${service})))`;
    expect(Number(await selectOne(url))).toBe(1);
  }, 30_000);

  it('connects with a SID', async () => {
    // The CDB's SID: the application user lives in the PDB, so a wrong password proves the listener accepted the SID.
    const url = `jdbc:oracle:thin:@${host}:${port}:${env.DBCLIENT_ORACLE_SID || 'FREE'}`;
    await expect(selectOne(url, 'system', 'not-the-password')).rejects.toThrow(/ORA-01017/);
    await expect(selectOne(`jdbc:oracle:thin:@${host}:${port}:NO_SUCH_SID`, 'system', 'x')).rejects.toThrow(/ORA-12505|NJS-/);
  }, 30_000);

  it('takes the credentials from the URL', async () => {
    const url = `jdbc:oracle:thin:${env.DBCLIENT_ORACLE_USER}/"${env.DBCLIENT_ORACLE_PASSWORD}"@//${host}:${port}/${service}`;
    expect(Number(await selectOne(url, '', ''))).toBe(1);
  }, 30_000);
});

// Through scripts/ssh-fixture.sh: the URL names the database as the SSH server sees it.
describe.skipIf(!host || !env.DBCLIENT_SSH_HOST)('oracle by JDBC URL through SSH', () => {
  it('rewrites the URL to the tunnel', async () => {
    const target = env.DBCLIENT_SSH_TARGET_HOST || host;
    const options: ConnectionConfig['options'] = {
      connectBy: 'JDBC URL',
      jdbcUrl: `jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${target})(PORT=${port}))(CONNECT_DATA=(SERVICE_NAME=${service})))`,
      user: env.DBCLIENT_ORACLE_USER,
      ssh: 'password',
      sshHost: env.DBCLIENT_SSH_HOST,
      sshPort: Number(env.DBCLIENT_SSH_PORT || 22),
      sshUser: env.DBCLIENT_SSH_USER,
    };
    const secrets = { password: env.DBCLIENT_ORACLE_PASSWORD, sshPassword: env.DBCLIENT_SSH_PASSWORD };
    const driver = (await connectDriver(oracleFactory, { id: 'jdbc-ssh', name: 'jdbc-ssh', type: 'oracle', options }, secrets)) as SqlDriver;
    try {
      const [result] = await driver.execute('select 1 as one from dual', { maxRows: 1 });
      expect(Number(result.rows[0][0])).toBe(1);
    } finally {
      await driver.disconnect();
    }
  }, 30_000);
});
