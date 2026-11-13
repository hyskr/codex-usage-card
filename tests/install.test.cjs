'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');

const runtime = process.env.BADGE_RUNTIME;
if (!runtime) throw new Error('BADGE_RUNTIME must point to the extracted release');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'badge-install-test-'));
fs.chmodSync(temporary, 0o700);
process.env.HOME = temporary;
const app = path.join(temporary, 'Codex.app');
const cli = path.join(app, 'Contents/Resources/codex-cli/bin/codex');
fs.mkdirSync(path.dirname(cli), { recursive: true });
fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.CODEX_BADGE_APP = app;
delete process.env.CODEX_HOME;

const jobs = new Set();
const dialogChoices = [];
let kickstarts = 0;
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (file === '/bin/launchctl') {
    const action = args[0];
    if (action === 'print') {
      if (!jobs.has(args[1])) {
        const label = args[1].split('/').at(-1);
        const error = new Error('not loaded');
        error.status = 113;
        error.stderr = `Could not find service "${label}" in domain for user gui: ${process.getuid()}`;
        throw error;
      }
      return 'state = running';
    }
    if (action === 'kickstart') { kickstarts++; return ''; }
    if (action === 'bootout') {
      jobs.delete(args[1]);
      return '';
    }
    if (action === 'bootstrap') {
      const basename = path.basename(args[2], '.plist');
      const label = basename === 'activate-once' ? 'com.codexusagebadge.activate-once' : basename;
      jobs.add(`gui/${process.getuid()}/${label}`);
      if (label === 'com.codexusagebadge.startup') {
        const receipt = path.join(temporary, 'Library/Application Support/CodexUsageBadge/startup-helper/state.json');
        fs.writeFileSync(receipt, JSON.stringify({ event: 'watching', updatedAt: Date.now() + 1 }));
      }
      return '';
    }
  }
  if (file === '/usr/bin/osascript') return dialogChoices.shift() ?? '好';
  if (file === '/usr/bin/plutil') return '{}';
  if (file.endsWith('/macos/startup/bridge') || file.endsWith('/startup-helper/bridge')) return JSON.stringify({ apps: [] });
  return execFileSync(file, args, options);
};

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './macos/compatibility.cjs') {
    return { inspectCompatibility: () => ({ status: 'VERIFIED', client: null }), confirmCompatibility: async () => {} };
  }
  return load.call(this, request, parent, isMain);
};

global.fetch = async () => { throw new Error('no window in fixture'); };

(async () => {
  try {
    const manager = require(path.join(runtime, 'manage.cjs'));
    assert.equal(manager.expectedUiVersion(), 72);
    let checks = 0;
    await manager.waitForExit({
      isRunning: () => {
        checks++;
        if (checks === 1) throw new Error('temporary snapshot failure');
        return checks < 3;
      },
      sleep: async () => {},
      now: () => 0,
      timeoutMs: 10000,
    });
    assert.equal(checks, 4, 'temporary detection failure does not cancel recovery');
    await manager.install();
    assert.equal(await manager.recoveryStatus(), 'Codex 尚未启动。打开 Codex 后徽标将尝试自动连接。');
    const directory = path.join(temporary, 'Library/Application Support/CodexUsageBadge');
    assert.equal(fs.readFileSync(path.join(directory, 'agent.cjs'), 'utf8'), fs.readFileSync(path.join(runtime, 'agent.cjs'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(directory, 'badge-tokenizer.cjs'), 'utf8'), fs.readFileSync(path.join(runtime, 'badge-tokenizer.cjs'), 'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'installed-version.json'))).version, '1.1.0');
    const shortcut = path.join(temporary, 'Applications/Codex 徽标管理.app');
    assert.equal(fs.readlinkSync(shortcut), path.join(directory, 'manager-app/Codex 徽标管理.app'));
    assert.ok(fs.statSync(path.join(directory, 'manager-app/Codex 徽标管理.app/Contents/MacOS/manager')).mode & 0o100);
    await manager.install();
    dialogChoices.push('重新连接', '关闭');
    await manager.managerUi();
    assert.equal(kickstarts, 2, 'both services are restarted');
    dialogChoices.push('退出后恢复', '好');
    await manager.managerUi();
    assert.ok(jobs.has(`gui/${process.getuid()}/com.codexusagebadge.activate-once`));
    await manager.uninstall();
    assert.equal(fs.existsSync(directory), false);
    assert.equal(jobs.size, 0);
    assert.equal(fs.existsSync(shortcut), false);
    const trash = path.join(temporary, '.Trash');
    assert.equal(fs.readdirSync(trash).length, 1);
    console.log('Fresh installation, upgrade and uninstall verified in an isolated home.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
