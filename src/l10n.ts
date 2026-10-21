import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Values of `dbclient.language`: `auto` follows the editor's display language. */
export const LANGUAGES = ['auto', 'en', 'es', 'pt-br'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Native names shown in the language selector (never translated). */
export const LANGUAGE_NAMES: Record<Exclude<Language, 'auto'>, string> = { en: 'English', es: 'Español', 'pt-br': 'Português (Brasil)' };

// undefined: follow the editor through vscode.l10n; otherwise the chosen bundle ({} for English).
let bundle: Record<string, string> | undefined;
let chosen: Language = 'auto';

export function configuredLanguage(): Language {
  const value = vscode.workspace.getConfiguration('dbclient').get<string>('language', 'auto');
  return (LANGUAGES as readonly string[]).includes(value) ? (value as Language) : 'auto';
}

/** Loads the bundle of `dbclient.language`; call on activation and when the setting changes. */
export function loadLanguage(extensionPath: string): void {
  chosen = configuredLanguage();
  if (chosen === 'auto') {
    bundle = undefined;
  } else if (chosen === 'en') {
    bundle = {};
  } else {
    try {
      bundle = JSON.parse(fs.readFileSync(path.join(extensionPath, 'l10n', `bundle.l10n.${chosen}.json`), 'utf8'));
    } catch {
      bundle = undefined;
    }
  }
}

/** Translates like `vscode.l10n.t`, honoring `dbclient.language`. */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  if (!bundle) {
    return vscode.l10n.t(message, ...args);
  }
  const text = typeof bundle[message] === 'string' ? bundle[message] : message;
  return text.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

/** The translations the webviews get (none for English). */
export function webviewBundle(): Record<string, string> {
  return bundle ?? vscode.l10n.bundle ?? {};
}

/** Language code of the interface, for `<html lang>`. */
export function interfaceLanguage(): string {
  return chosen === 'auto' ? vscode.env.language : chosen;
}
