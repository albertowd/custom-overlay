// npm sometimes skips Electron's postinstall (e.g. when the workspace is added later); make sure
// the Electron binary was downloaded.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0);
}
if (!existsSync(join(electronDir, 'path.txt'))) {
  console.log('Downloading the Electron binary...');
  const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
