// Launches a real VS Code with the extension and runs test/smoke/suite inside it.
// Engine settings come from DBCLIENT_* variables (see test/integration).
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
    // Forward the DBCLIENT_* settings; the suite injects passwords without SecretStorage.
    extensionTestsEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DBCLIENT_'))),
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
