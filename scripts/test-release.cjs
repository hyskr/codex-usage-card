'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const name = `CodexUsageBadge-${version}-macOS`;
const archive = path.join(root, 'dist', `${name}.zip`);
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'badge-release-test-'));

try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, temporary], { stdio: 'inherit' });
  const env = { ...process.env, BADGE_RUNTIME: path.join(temporary, name) };
  for (const test of ['install.test.cjs', 'renderer.test.cjs', 'quota.test.cjs']) {
    execFileSync(process.execPath, [path.join(root, 'tests', test)], { env, stdio: 'inherit' });
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
