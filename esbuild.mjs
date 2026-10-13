import * as esbuild from 'esbuild';

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

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
