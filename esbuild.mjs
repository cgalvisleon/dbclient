import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  // vscode is provided by the host; pg-native is an optional pg backend we never load;
  // cpu-features and *.node are ssh2's optional native speedups (loaded in try/catch, pure-JS
  // fallback), never shipped so the extension stays free of native modules.
  external: ['vscode', 'pg-native', 'cpu-features'],
  plugins: [
    {
      name: 'skip-native-addons',
      setup(build) {
        build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

// CodeMirror for the SQL editor webview: one browser script in media/vendor/ (webviews load
// plain scripts from media/ under their CSP).
const webview = await esbuild.context({
  entryPoints: ['webview-src/codemirror.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'media/vendor/codemirror.js',
  minify: production,
  logLevel: 'info',
});

// VS Code's icon font for the SQL editor toolbar.
fs.mkdirSync('media/vendor', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `media/vendor/${file}`);
}

if (watch) {
  await Promise.all([ctx.watch(), webview.watch()]);
} else {
  await Promise.all([ctx.rebuild(), webview.rebuild()]);
  await Promise.all([ctx.dispose(), webview.dispose()]);
}
