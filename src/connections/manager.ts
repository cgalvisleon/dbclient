import * as vscode from 'vscode';
import { getDriver } from '../drivers/registry';
import { connectDriver } from '../drivers/sshTunnel';
import {
  ConnectionConfig,
  ConnectionSecrets,
  Driver,
  DriverFactory,
  isKvDriver,
  isPubSubDriver,
  isSqlDriver,
  KvDriver,
  PubSubDriver,
  SqlDriver,
} from '../drivers/types';
import { isProduction, sessionLimitMs } from '../drivers/production';
import { ConnectionStore } from '../store/connectionStore';
import { t } from '../l10n';

/** Owns the live driver instance of each connected connection. */
export class ConnectionManager implements vscode.Disposable {
  private readonly active = new Map<string, Driver>();
  private readonly pending = new Map<string, Promise<Driver>>();
  /** Session timers of production connections, and when each one ends. */
  private readonly sessionTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; endsAt: number }>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires the connection id whose connected state changed. */
  readonly onDidChangeState = this.changed.event;
  private readonly contentChanged = new vscode.EventEmitter<string>();
  /** Fires the connection id whose driver-side content changed (e.g. NATS subscriptions). */
  readonly onDidChangeContent = this.contentChanged.event;

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
      throw new Error(t('Connection not found. It may have been deleted.'));
    }
    return config;
  }

  /**
   * Live driver of a connection, connecting it when needed. A production connection only connects
   * when `manual` (the user's explicit Connect); anything else gets an error asking for it.
   */
  async connect(id: string, options: { manual?: boolean } = {}): Promise<Driver> {
    const active = this.active.get(id);
    if (active) {
      return active;
    }
    let pending = this.pending.get(id);
    if (!pending) {
      const config = this.config(id);
      if (isProduction(config) && !options.manual) {
        throw new Error(t('{0} is a production connection: connect it with Connect on the connection.', config.name));
      }
      pending = (async () => {
        const factory = this.factoryOf(config);
        let driver: Driver | undefined;
        // An SSH tunnel that drops on its own leaves the driver useless: mark it disconnected.
        driver = await connectDriver(factory, config, await this.store.getSecrets(id, factory.fields), () => {
          if (driver && this.active.get(id) === driver) {
            void this.disconnect(id);
          }
        });
        this.active.set(id, driver);
        this.startSession(id, config);
        driver.onDidChange?.(() => this.active.get(id) === driver && this.contentChanged.fire(id));
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
      throw new Error(t('{0} is not a SQL connection.', this.config(id).name));
    }
    return driver;
  }

  async connectKv(id: string): Promise<KvDriver> {
    const driver = await this.connect(id);
    if (!isKvDriver(driver)) {
      throw new Error(t('{0} is not a Redis connection.', this.config(id).name));
    }
    return driver;
  }

  async connectPubSub(id: string): Promise<PubSubDriver> {
    const driver = await this.connect(id);
    if (!isPubSubDriver(driver)) {
      throw new Error(t('{0} is not a NATS connection.', this.config(id).name));
    }
    return driver;
  }

  /** Tells the tree that a connection's objects changed (DDL, drops), so its subtree is re-read. */
  contentChangedOf(id: string): void {
    if (this.active.has(id)) {
      this.contentChanged.fire(id);
    }
  }

  /** When the session of a connected production connection ends (epoch ms); undefined without a limit. */
  sessionEndsAt(id: string): number | undefined {
    return this.sessionTimers.get(id)?.endsAt;
  }

  private startSession(id: string, config: ConnectionConfig): void {
    this.stopSession(id);
    const limit = sessionLimitMs(config);
    if (!limit) {
      return;
    }
    const timer = setTimeout(() => void this.expire(id), limit);
    this.sessionTimers.set(id, { timer, endsAt: Date.now() + limit });
  }

  private stopSession(id: string): void {
    const session = this.sessionTimers.get(id);
    if (session) {
      clearTimeout(session.timer);
      this.sessionTimers.delete(id);
    }
  }

  /** The production session ran out: disconnect and offer to connect again (still a manual action). */
  private async expire(id: string): Promise<void> {
    this.sessionTimers.delete(id);
    if (!this.active.has(id)) {
      return;
    }
    const name = this.store.get(id)?.name ?? id;
    await this.disconnect(id);
    const again = t('Connect');
    const picked = await vscode.window.showWarningMessage(
      t('{0} was disconnected: its production session time ended. Connect again to go on.', name),
      again,
    );
    if (picked === again && this.store.get(id)) {
      await vscode.window
        .withProgress({ location: { viewId: 'dbclient.connections' }, title: t('Connecting…') }, () => this.connect(id, { manual: true }))
        .then(undefined, (err) => vscode.window.showErrorMessage(t('{0}: {1}', name, (err as Error).message)));
    }
  }

  /** Live driver, without connecting. */
  driver(id: string): Driver | undefined {
    return this.active.get(id);
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.active.get(id);
    if (!driver) {
      return;
    }
    this.active.delete(id);
    this.stopSession(id);
    // Announced before closing: a driver may wait for the query in flight, and a run listening for
    // this ends at once (SqlRunner) instead of waiting for it.
    this.changed.fire(id);
    await driver.disconnect().catch(() => undefined);
  }

  /** Connects a throwaway driver with the given values; used by "Test Connection" and the form. */
  async test(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    const driver = await connectDriver(getDriver(config.type), config, secrets);
    await driver.disconnect().catch(() => undefined);
  }

  dispose(): void {
    for (const session of this.sessionTimers.values()) {
      clearTimeout(session.timer);
    }
    this.sessionTimers.clear();
    for (const driver of this.active.values()) {
      void driver.disconnect().catch(() => undefined);
    }
    this.active.clear();
    this.changed.dispose();
    this.contentChanged.dispose();
  }
}
