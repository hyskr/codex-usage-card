'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const runtime = process.env.BADGE_RUNTIME;
if (!runtime) throw new Error('BADGE_RUNTIME must point to the extracted release');
const { buildBootstrapScript, formatRateLimits } = require(path.join(runtime, 'agent.cjs'));

function createWindow(html) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/',
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.eval(buildBootstrapScript());
  return window;
}

function notify(window, method, params) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'mcp-notification', method, params },
  }));
}

async function testSelectedConversation() {
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const window = createWindow(`
    <div data-app-action-sidebar-thread-id="${a}" data-app-action-sidebar-thread-active="true"></div>
    <div data-app-action-sidebar-thread-id="${b}" data-app-action-sidebar-thread-active="false"></div>
  `);
  const rows = window.document.querySelectorAll('[data-app-action-sidebar-thread-id]');
  const number = kind => window.document.querySelector(`.${kind} .usage-number`).textContent;
  const usage = (threadId, tokens) => notify(window, 'thread/tokenUsage/updated', {
    threadId, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: tokens, totalTokens: tokens * 10 }, modelContextWindow: 1000 },
  });
  usage(a, 42);
  usage(b, 99);
  assert.equal(number('usage-cache'), '42');
  assert.equal(number('usage-context'), '42');
  rows[0].setAttribute('data-app-action-sidebar-thread-active', 'false');
  rows[1].setAttribute('data-app-action-sidebar-thread-active', 'true');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(number('usage-cache'), '99');
  assert.equal(number('usage-context'), '99');
  window.__codexUsageBadge.destroy();
  window.close();
}

async function testOverlayPlacement() {
  const window = createWindow(`
    <nav data-app-navigation-rail id="rail">
      <div id="footer"><button aria-label="account"></button></div>
    </nav><div role="dialog" id="dialog"></div>
  `);
  const rectangle = (left, top, width, height) => ({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
  });
  let dialogRect = rectangle(500, 100, 200, 200);
  const badge = window.document.querySelector('#codex-usage-badge');
  window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static', overflowX: 'visible', overflowY: 'visible' });
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'rail') return rectangle(0, 0, 58, 800);
    if (this.id === 'footer') return rectangle(0, 750, 58, 40);
    if (this.id === 'dialog') return dialogRect;
    if (this.id === 'codex-usage-tooltip') return rectangle(100, 350, 300, 300);
    if (this.id === 'codex-usage-badge') return rectangle(parseFloat(this.style.left) || 8, parseFloat(this.style.top) || 500, 42, 175);
    if (this.tagName === 'BUTTON') return rectangle(10, 750, 38, 35);
    return rectangle(0, 0, 1000, 800);
  };
  window.document.elementFromPoint = () => badge;
  window.__codexUsageBadge.place();
  assert.equal(window.__codexUsageBadge.status().placed, true, 'unrelated dialog must not hide badge');
  badge.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise(resolve => setTimeout(resolve, 150));
  const tooltip = window.document.querySelector('#codex-usage-tooltip');
  assert.equal(tooltip.hidden, false, 'hover opens details');
  dialogRect = rectangle(150, 400, 50, 50);
  window.__codexUsageBadge.place();
  assert.equal(badge.hidden, false, 'a dialog covering details must not hide the badge');
  assert.equal(tooltip.hidden, true, 'details yield to the overlapping dialog');
  dialogRect = rectangle(500, 100, 200, 200);
  badge.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(tooltip.hidden, false, 'details reopen after dialog moves');
  badge.dispatchEvent(new window.MouseEvent('mouseleave'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tooltip.hidden, true, 'details close promptly after mouse leaves');
  badge.dispatchEvent(new window.MouseEvent('mouseenter'));
  badge.dispatchEvent(new window.MouseEvent('mouseleave'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tooltip.hidden, true, 'a short hover must not open details late');
  dialogRect = rectangle(0, 500, 100, 250);
  window.__codexUsageBadge.place();
  assert.equal(badge.hidden, true, 'overlapping dialog must hide badge');
  dialogRect = rectangle(500, 100, 200, 200);
  window.__codexUsageBadge.place();
  assert.equal(window.__codexUsageBadge.status().placed, true, 'badge must return when overlap ends');
  window.__codexUsageBadge.destroy();
  window.close();
}

function testWeeklyInCompactRail() {
  const window = createWindow(`
    <nav data-app-navigation-rail id="rail">
      <div id="footer"><button aria-label="account"></button></div>
    </nav>
  `);
  const rectangle = (left, top, width, height) => ({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
  });
  const badge = window.document.querySelector('#codex-usage-badge');
  window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static', overflowX: 'visible', overflowY: 'visible' });
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'rail') return rectangle(0, 0, 58, 800);
    if (this.id === 'footer') return rectangle(0, 80, 58, 40);
    if (this.id === 'codex-usage-badge') {
      const count = [...this.children].filter(element => !element.hidden).length;
      return rectangle(parseFloat(this.style.left) || 8, parseFloat(this.style.top) || 0, 42, count * 47);
    }
    if (this.tagName === 'BUTTON') return rectangle(10, 80, 38, 35);
    return rectangle(0, 0, 1000, 800);
  };
  window.document.elementFromPoint = () => badge;
  const data = formatRateLimits({ rateLimits: { planType: 'plus',
    primary: { usedPercent: 10, windowDurationMins: 300 },
    secondary: { usedPercent: 49, windowDurationMins: 10080 } } });
  window.__codexUsageBadge.update({ ...data, updatedAt: Date.now(), stale: false });
  assert.equal(window.__codexUsageBadge.status().placed, true, 'weekly ring remains mounted');
  assert.equal(badge.querySelector('.usage-primary').hidden, true);
  assert.equal(badge.querySelector('.usage-secondary').hidden, false);
  assert.equal(badge.querySelector('.usage-secondary .usage-number').textContent, '51');
  window.__codexUsageBadge.destroy();
  window.close();
}

(async () => {
  await testSelectedConversation();
  await testOverlayPlacement();
  testWeeklyInCompactRail();
  const weekly = { usedPercent: 49, windowDurationMins: 10080 };
  for (const planType of ['prolite', 'team', '']) {
    const reading = formatRateLimits({ rateLimits: { planType, primary: weekly, secondary: null } });
    assert.equal(reading.percent, 51, `weekly-only ${planType} account`);
    assert.equal(reading.windowLabel, '周');
  }
  console.log('Renderer behavior verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
