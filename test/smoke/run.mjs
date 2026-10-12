// Launches a real VS Code with the extension and runs test/smoke/suite inside it.
// Postgres settings come from DBCLIENT_PG_* (see test/integration/postgres.test.ts).
import { runTests } from '@vscode/test-electron';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dbclient-smoke-'));

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test/smoke/suite/index.js'),
    launchArgs: ['--disable-extensions', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes'],
    // The driver falls back to PGPASSWORD, so the test never touches the OS keychain.
    extensionTestsEnv: { PGPASSWORD: process.env.DBCLIENT_PG_PASSWORD ?? '' },
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
