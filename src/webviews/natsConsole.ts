import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { PubSubMessage } from '../drivers/types';
import { icon } from '../icons';
import { mediaRoots, webviewHtml } from './html';
import { t } from '../l10n';

const BUFFER = 1000;

type FromView =
  | { type: 'ready' }
  | { type: 'publish'; subject: string; data: string; headers: Record<string, string>; reply?: string }
  | { type: 'request'; subject: string; data: string; headers: Record<string, string>; timeoutMs: number }
  | { type: 'subscribe'; subject: string; queue?: string }
  | { type: 'unsubscribe'; id: number }
  | { type: 'clear' }
  | { type: 'copy'; text: string };

interface ConsoleState {
  panel?: vscode.WebviewPanel;
  /** Received messages, kept while the connection is open so reopening the console shows them. */
  messages: (PubSubMessage & { kind: 'message' | 'reply' | 'sent' })[];
}

/** One console per NATS connection; subscriptions live in the driver and outlive the panel. */
export class NatsConsoles implements vscode.Disposable {
  private readonly states = new Map<string, ConsoleState>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
  ) {
    this.subscriptions = [
      manager.onDidChangeState((id) => {
        if (!manager.isConnected(id)) {
          // Subscriptions died with the connection.
          const state = this.states.get(id);
          if (state) {
            state.messages = [];
            this.postState(id);
          }
        }
      }),
      manager.onDidChangeContent((id) => this.postState(id)),
    ];
  }

  private state(id: string): ConsoleState {
    let state = this.states.get(id);
    if (!state) {
      state = { messages: [] };
      this.states.set(id, state);
    }
    return state;
  }

  private post(id: string, message: unknown): void {
    void this.states.get(id)?.panel?.webview.postMessage(message);
  }

  private postState(id: string): void {
    const state = this.states.get(id);
    if (!state?.panel) {
      return;
    }
    const driver = this.manager.driver(id);
    const subs = driver && 'subscriptions' in driver ? (driver as { subscriptions(): unknown[] }).subscriptions() : [];
    this.post(id, { type: 'state', connected: this.manager.isConnected(id), subscriptions: subs });
  }

  private push(id: string, message: ConsoleState['messages'][number]): void {
    const state = this.state(id);
    state.messages.push(message);
    if (state.messages.length > BUFFER) {
      state.messages.splice(0, state.messages.length - BUFFER);
    }
    this.post(id, { type: 'message', message });
  }

  async open(connectionId: string, presetSubject?: string): Promise<void> {
    const state = this.state(connectionId);
    const config = this.manager.config(connectionId);
    if (state.panel) {
      state.panel.reveal();
      if (presetSubject) {
        this.post(connectionId, { type: 'preset', subject: presetSubject });
      }
      return;
    }
    await this.manager.connectPubSub(connectionId);
    const panel = vscode.window.createWebviewPanel('dbclient.natsConsole', `NATS · ${config.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: mediaRoots(this.extensionUri),
    });
    panel.iconPath = icon('terminal');
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'natsConsole', config.name);
    state.panel = panel;
    panel.onDidDispose(() => (state.panel = undefined));
    panel.webview.onDidReceiveMessage((m: FromView) => this.receive(connectionId, m, presetSubject));
  }

  private async receive(id: string, m: FromView, presetSubject?: string): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.post(id, { type: 'init', connection: this.manager.config(id).name, messages: this.state(id).messages, preset: presetSubject });
          this.postState(id);
          return;
        case 'publish': {
          const driver = await this.manager.connectPubSub(id);
          await driver.publish(m.subject, m.data, m.headers, m.reply);
          this.push(id, { kind: 'sent', subscription: 0, subject: m.subject, data: m.data, headers: wrap(m.headers), reply: m.reply, time: new Date().toISOString() });
          return;
        }
        case 'request': {
          const driver = await this.manager.connectPubSub(id);
          this.push(id, { kind: 'sent', subscription: 0, subject: m.subject, data: m.data, headers: wrap(m.headers), time: new Date().toISOString() });
          const reply = await driver.request(m.subject, m.data, m.headers, m.timeoutMs);
          this.push(id, { ...reply, kind: 'reply' });
          return;
        }
        case 'subscribe': {
          const driver = await this.manager.connectPubSub(id);
          driver.subscribe(m.subject, m.queue, (message) => this.push(id, { ...message, kind: 'message' }));
          return;
        }
        case 'unsubscribe': {
          const driver = await this.manager.connectPubSub(id);
          driver.unsubscribe(m.id);
          return;
        }
        case 'clear':
          this.state(id).messages = [];
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(t('Copied to clipboard'), 2000);
          return;
      }
    } catch (err) {
      this.post(id, { type: 'error', message: (err as Error).message });
    }
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    for (const state of this.states.values()) {
      state.panel?.dispose();
    }
  }
}

function wrap(headers: Record<string, string>): Record<string, string[]> | undefined {
  const entries = Object.entries(headers).filter(([k]) => k);
  return entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, [v]])) : undefined;
}
