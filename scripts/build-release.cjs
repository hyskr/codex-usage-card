'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const packageName = `CodexUsageBadge-${version}-macOS`;
const outputDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-badge-release-'));
const bundle = path.join(temporary, packageName);

try {
  execFileSync(require.resolve('esbuild/bin/esbuild'), ['src/tokenizer.mjs',
    '--bundle', '--minify', '--format=iife', '--global-name=badgeTokenizer',
    '--outfile=build/badge-tokenizer.cjs'], { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(bundle, { recursive: true });
  fs.cpSync(path.join(root, 'src'), bundle, { recursive: true, filter: source => !source.endsWith('tokenizer.mjs') });
  fs.copyFileSync(path.join(root, 'build/badge-tokenizer.cjs'), path.join(bundle, 'badge-tokenizer.cjs'));
  fs.mkdirSync(path.join(bundle, 'scripts'));
  fs.copyFileSync(path.join(root, 'packaging/mac-entry.sh'), path.join(bundle, 'scripts/mac-entry.sh'));
  for (const name of ['安装.command', '卸载.command', '诊断.command']) {
    fs.copyFileSync(path.join(root, 'packaging', name), path.join(bundle, name));
    fs.chmodSync(path.join(bundle, name), 0o755);
  }
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.copyFileSync(path.join(root, name), path.join(bundle, name));
  }
  fs.cpSync(path.join(root, 'licenses'), path.join(bundle, 'licenses'), { recursive: true });
  fs.cpSync(path.join(root, 'docs'), path.join(bundle, 'docs'), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const archive = path.join(outputDir, `${packageName}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive], { stdio: 'inherit' });
  console.log(archive);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
