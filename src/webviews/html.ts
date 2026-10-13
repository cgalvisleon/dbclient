import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** HTML shell for a webview that loads `media/<name>.js` and `media/<name>.css` under a strict CSP. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, name: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  // The active language's translations (none for English), safe inside a <script> element.
  const l10n = JSON.stringify(vscode.l10n.bundle ?? {}).replace(/</g, '\\u003c');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media(`${name}.css`)}" rel="stylesheet">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="dbclient-l10n">${l10n}</script>
<script nonce="${nonce}" src="${media('l10n.js')}"></script>
<script nonce="${nonce}" src="${media(`${name}.js`)}"></script>
</body>
</html>`;
}

export function mediaRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media')];
}
