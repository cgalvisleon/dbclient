import { DriverFactory } from './types';
import { mssqlFactory } from './mssql';
import { mysqlFactory } from './mysql';
import { natsFactory } from './nats';
import { oracleFactory } from './oracle';
import { postgresFactory } from './postgres';
import { redisFactory } from './redis';
import { sqliteFactory } from './sqlite';

// Adding an engine means writing its factory and listing it here; the tree, form,
// editor and grid only consume the DriverFactory/Driver contracts.
const factories: DriverFactory[] = [postgresFactory, mysqlFactory, mssqlFactory, oracleFactory, sqliteFactory, redisFactory, natsFactory];

const byType = new Map(factories.map((f) => [f.type, f]));

export function allDrivers(): DriverFactory[] {
  return factories;
}

export function getDriver(type: string): DriverFactory {
  const factory = byType.get(type);
  if (!factory) {
    throw new Error(`Unsupported connection type: ${type}`);
  }
  return factory;
}
