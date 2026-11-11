'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { StartupController } = require(path.join(process.env.BADGE_RUNTIME, 'macos/startup/controller.cjs'));

async function baseline(apps, expected) {
  const records = [];
  const controller = new StartupController({
    snapshot: async () => ({ apps }),
    record: async (event, details) => records.push({ event, ...details }),
  });
  await controller.tick();
  assert.equal(records[0].event, 'watching');
  assert.equal(records[0].connectionState, expected);
  await controller.tick();
  assert.equal(records.length, 1, 'an existing client is not restarted');
}

(async () => {
  let attempts = 0;
  const records = [];
  const retry = new StartupController({
    snapshot: async () => { if (++attempts === 1) throw Error('temporary'); return { apps: [] }; },
    record: async event => records.push(event),
  });
  await retry.tick();
  assert.equal(retry.pendingLaunch, true);
  await retry.tick();
  assert.deepEqual(records, ['error', 'watching']);
  await baseline([], 'waiting-for-codex');
  await baseline([{ key: 'a', argumentsKnown: true, debugPort: null }], 'needs-relaunch');
  await baseline([{ key: 'a', argumentsKnown: true, debugPort: '62104' }], 'port-detected');
  console.log('Existing-client startup states verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
