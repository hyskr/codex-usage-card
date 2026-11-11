'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = process.env.BADGE_RUNTIME;
if (!runtime) throw new Error('BADGE_RUNTIME must point to the extracted release');
const { AppServerClient, RendererInjector, formatRateLimits } = require(path.join(runtime, 'agent.cjs'));

async function testRefreshNotification() {
  const client = new AppServerClient();
  let respond;
  client.request = () => new Promise(resolve => { respond = resolve; });
  const seen = [];
  client.on('rate-limits', value => seen.push(formatRateLimits(value).percent));
  const pending = client.refresh();
  client.applyRateLimitsNotification({ rateLimits: { planType: 'pro', primary: { usedPercent: 82, windowDurationMins: 10080 } } });
  assert.deepEqual(seen, [18]);
  respond({ rateLimits: { planType: 'pro', primary: { usedPercent: 81, windowDurationMins: 10080 } } });
  await pending;
  assert.deepEqual(seen, [18, 18], 'a refresh response must not overwrite a newer notification');
  assert.equal(client.refreshPatches, null);
}

async function testRendererBridge() {
  const originalFetch = global.fetch;
  const OriginalWebSocket = global.WebSocket;
  const childProcess = require('node:child_process');
  const originalExecFile = childProcess.execFile;
  let snapshotFails = false;
  childProcess.execFile = (file, args, options, callback) => {
    if (snapshotFails) return callback(Error('temporary snapshot failure'));
    callback(null, JSON.stringify({ apps: [{ argumentsKnown: true, debugPort: '62104' }] }));
  };
  let socket;
  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      socket = this;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.methods = [];
      queueMicrotask(() => this.dispatch('open', {}));
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }
    dispatch(type, event) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
    send(raw) {
      const message = JSON.parse(raw);
      this.methods.push(message);
      let value;
      if (message.method === 'Runtime.evaluate') {
        value = message.params.expression.includes('status()')
          ? { version: 72, placed: true, badgeCount: 1 }
          : 72;
      }
      queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({
        id: message.id, result: { result: { value } },
      }) }));
    }
    close() { this.readyState = 3; this.dispatch('close', {}); }
  }
  global.WebSocket = FakeWebSocket;
  global.fetch = async () => ({ ok: true, json: async () => [{
    id: 'main', type: 'page', url: 'app://-/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:62104/devtools/page/main',
  }] });
  try {
    const received = [];
    const injector = new RendererInjector({ port: 39222 });
    injector.onRateLimits = patch => received.push(patch);
    await injector.scan();
    assert.equal(injector.activePort, 62104);
    snapshotFails = true;
    await injector.scan();
    assert.equal(injector.sessions.size, 1, 'transient discovery failure retains the current connection');
    snapshotFails = false;
    assert.ok(socket.methods.some(message => message.method === 'Runtime.addBinding' &&
      message.params.name === '__codexUsageBadgeQuotaUpdated'));
    socket.dispatch('message', { data: JSON.stringify({ method: 'Runtime.bindingCalled',
      params: { name: '__codexUsageBadgeQuotaUpdated', payload: JSON.stringify({ rateLimits: { primary: { usedPercent: 83 } } }) } }) });
    assert.equal(received[0].rateLimits.primary.usedPercent, 83);
    injector.stop();
  } finally {
    childProcess.execFile = originalExecFile;
    global.fetch = originalFetch;
    global.WebSocket = OriginalWebSocket;
  }
}

(async () => {
  await testRefreshNotification();
  await testRendererBridge();
  console.log('Quota notifications and concurrent refresh verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
