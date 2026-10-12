import * as vscode from 'vscode';
import { getDriver } from '../drivers/registry';
import { ConnectionConfig, ConnectionSecrets, Driver, DriverFactory, isSqlDriver, SqlDriver } from '../drivers/types';
import { ConnectionStore } from '../store/connectionStore';

/** Owns the live driver instance of each connected connection. */
export class ConnectionManager implements vscode.Disposable {
  private readonly active = new Map<string, Driver>();
  private readonly pending = new Map<string, Promise<Driver>>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires the connection id whose connected state changed. */
  readonly onDidChangeState = this.changed.event;

  constructor(readonly store: ConnectionStore) {}

  isConnected(id: string): boolean {
    return this.active.has(id);
  }

  factoryOf(config: ConnectionConfig): DriverFactory {
    return getDriver(config.type);
  }

  config(id: string): ConnectionConfig {
    const config = this.store.get(id);
    if (!config) {
      throw new Error(vscode.l10n.t('Connection not found. It may have been deleted.'));
    }
    return config;
  }

  async connect(id: string): Promise<Driver> {
    const active = this.active.get(id);
    if (active) {
      return active;
    }
    let pending = this.pending.get(id);
    if (!pending) {
      pending = (async () => {
        const config = this.config(id);
        const factory = this.factoryOf(config);
        const driver = factory.create(config, await this.store.getSecrets(id, factory.fields));
        try {
          await driver.connect();
        } catch (err) {
          await driver.disconnect().catch(() => undefined);
          throw err;
        }
        this.active.set(id, driver);
        this.changed.fire(id);
        return driver;
      })().finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    return pending;
  }

  async connectSql(id: string): Promise<SqlDriver> {
    const driver = await this.connect(id);
    if (!isSqlDriver(driver)) {
      throw new Error(vscode.l10n.t('{0} is not a SQL connection.', this.config(id).name));
    }
    return driver;
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.active.get(id);
    if (!driver) {
      return;
    }
    this.active.delete(id);
    await driver.disconnect().catch(() => undefined);
    this.changed.fire(id);
  }

  /** Connects a throwaway driver with the given values; used by "Test Connection" and the form. */
  async test(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    const driver = getDriver(config.type).create(config, secrets);
    try {
      await driver.connect();
    } finally {
      await driver.disconnect().catch(() => undefined);
    }
  }

  dispose(): void {
    for (const driver of this.active.values()) {
      void driver.disconnect().catch(() => undefined);
    }
    this.active.clear();
    this.changed.dispose();
  }
}
