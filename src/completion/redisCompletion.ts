import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { escapeGlob } from '../drivers/redis';
import { DocumentBindings } from '../editor/bindings';
import { parseArgs } from '../editor/redisCommands';
import { REDIS_COMMANDS } from './redisCommands';

const byName = new Map(REDIS_COMMANDS.map((c) => [c.name, c]));

/** Command names at the start of a line; existing keys (via SCAN) as the first argument of key commands. */
export class RedisCompletionProvider implements vscode.CompletionItemProvider {
  private keyCache?: { at: number; prefix: string; db: number; keys: string[] };

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: DocumentBindings,
  ) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    if (/^\s*(#|\/\/)/.test(before)) {
      return [];
    }
    let args: string[];
    try {
      args = parseArgs(before);
    } catch {
      return [];
    }
    const typingNew = /\s$/.test(before) || before.trim() === '';
    const index = typingNew ? args.length : args.length - 1;

    if (index <= 0 || (index === 1 && byName.has(`${args[0].toUpperCase()} ${(typingNew ? '' : args[1] ?? '').toUpperCase()}`.trim()))) {
      return this.commands(before.trim() === before.trimStart() ? '' : '', /[a-z]/.test(args[0] ?? '') && !/[A-Z]/.test(args[0] ?? ''));
    }

    // Two-word commands (CONFIG GET, XINFO STREAM) take their key one position later.
    const two = byName.get(`${args[0].toUpperCase()} ${(args[1] ?? '').toUpperCase()}`);
    const command = two ?? byName.get(args[0].toUpperCase());
    const keyIndex = two ? 2 : 1;
    if (!command) {
      return [];
    }
    if (!command.key || index !== keyIndex) {
      return this.options(command.args, typingNew ? '' : args[index], position);
    }
    const prefix = typingNew ? '' : args[index];
    return (await this.keys(doc, prefix)).map((key) => {
      const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
      item.detail = 'key';
      item.range = new vscode.Range(position.translate(0, -prefix.length), position);
      return item;
    });
  }

  /** Literal option tokens of the command's syntax (NX, EX, WITHSCORES, ...). */
  private options(syntax: string, typed: string, position: vscode.Position): vscode.CompletionItem[] {
    const tokens = [...new Set(syntax.match(/\b[A-Z][A-Z_]+\b/g) ?? [])];
    const lower = typed.length > 0 && typed === typed.toLowerCase();
    return tokens.map((token) => {
      const item = new vscode.CompletionItem(lower ? token.toLowerCase() : token, vscode.CompletionItemKind.EnumMember);
      item.detail = syntax;
      item.range = new vscode.Range(position.translate(0, -typed.length), position);
      return item;
    });
  }

  private commands(_unused: string, lower: boolean): vscode.CompletionItem[] {
    return REDIS_COMMANDS.map((c) => {
      const label = lower ? c.name.toLowerCase() : c.name;
      const item = new vscode.CompletionItem({ label, detail: c.args ? ` ${c.args}` : undefined, description: c.group }, vscode.CompletionItemKind.Function);
      item.documentation = new vscode.MarkdownString(`\`${c.name} ${c.args}\`\n\n${c.summary}`);
      item.insertText = `${label} `;
      item.command = c.key ? { command: 'editor.action.triggerSuggest', title: '' } : undefined;
      return item;
    });
  }

  private async keys(doc: vscode.TextDocument, prefix: string): Promise<string[]> {
    const binding = this.bindings.get(doc);
    if (!binding || !this.manager.isConnected(binding.connectionId)) {
      return [];
    }
    const db = Number(binding.database ?? this.manager.config(binding.connectionId).options.db ?? 0);
    const cache = this.keyCache;
    if (cache && cache.db === db && prefix.startsWith(cache.prefix) && Date.now() - cache.at < 5000) {
      return cache.keys.filter((k) => k.startsWith(prefix));
    }
    try {
      const driver = await this.manager.connectKv(binding.connectionId);
      const { keys } = await driver.scan(db, `${escapeGlob(prefix)}*`, 200);
      this.keyCache = { at: Date.now(), prefix, db, keys };
      return keys;
    } catch {
      return [];
    }
  }
}
