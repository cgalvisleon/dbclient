import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { interfaceLanguage, webviewBundle } from '../l10n';

/** More files of `media/` for a page: scripts before and after `<name>.js`, and style sheets. */
export interface WebviewExtras {
  before?: string[];
  after?: string[];
  styles?: string[];
  /** Lets scripts add `<style>` elements carrying the page nonce (CodeMirror); the nonce is in `<meta name="dbclient-nonce">`. */
  styleNonce?: boolean;
}

/** HTML shell for a webview that loads `media/<name>.js` and `media/<name>.css` under a strict CSP. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, name: string, title: string, extras: WebviewExtras = {}): string {
  const nonce = randomBytes(16).toString('base64');
  // The active language's translations (none for English), safe inside a <script> element.
  const l10n = JSON.stringify(webviewBundle()).replace(/</g, '\\u003c');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const scripts = (files: string[] = []) => files.map((file) => `<script nonce="${nonce}" src="${media(file)}"></script>\n`).join('');
  const styleSrc = extras.styleNonce ? `${webview.cspSource} 'nonce-${nonce}'` : webview.cspSource;
  return `<!DOCTYPE html>
<html lang="${interfaceLanguage()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; img-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${(extras.styles ?? []).map((file) => `<link href="${media(file)}" rel="stylesheet">\n`).join('')}<link href="${media(`${name}.css`)}" rel="stylesheet">
${extras.styleNonce ? `<meta name="dbclient-nonce" content="${nonce}">` : ''}
<title>${title}</title>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="dbclient-l10n">${l10n}</script>
<script nonce="${nonce}" src="${media('l10n.js')}"></script>
${scripts(extras.before)}<script nonce="${nonce}" src="${media(`${name}.js`)}"></script>
${scripts(extras.after)}
</body>
</html>`;
}

export function mediaRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media')];
}
