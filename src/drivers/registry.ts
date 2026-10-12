import { DriverFactory } from './types';
import { postgresFactory } from './postgres';

// Adding an engine means writing its factory and listing it here; the tree, form,
// editor and grid only consume the DriverFactory/Driver contracts.
const factories: DriverFactory[] = [postgresFactory];

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
