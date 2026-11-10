"use strict";
// Formatting is independent of platform and account storage.
function remainingPercent(used) { return Math.max(0, Math.min(100, Math.round(100 - used))); }
function validWindow(value) { return value != null && Number.isFinite(value.usedPercent); }
function isCodexLimit(value) { return value?.limitId == null || value.limitId === 'codex'; }
function formatResetTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}).format(date);
}
function durationLabel(minutes) {
  for (const [unit, label] of [[10080,'周'],[1440,'天'],[60,'小时']]) {
    if (Number.isFinite(minutes) && minutes > 0 && minutes % unit === 0) return `${minutes / unit}${label}`;
  }
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes}分钟` : '额度';
}
function formatResetCredits(response) {
  const credits = response?.rateLimitResetCredits;
  if (!credits || typeof credits !== 'object') return [];
  const available = Array.isArray(credits.credits) ? credits.credits.filter(c => c?.status === 'available' && c?.resetType === 'codexRateLimits') : [];
  const count = Number.isFinite(Number(credits.availableCount)) ? Math.max(0, Math.floor(Number(credits.availableCount))) : available.length;
  const expiry = formatResetTime(available.map(c=>c.expiresAt).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b)[0]);
  return [`重置卡：${count} 张可用`, ...(count && expiry ? [`最近到期：${expiry}`] : [])];
}
function formatPrimaryRateLimits(response) {
  const snapshot = pickCodexSnapshot(response);
  const windows = [snapshot?.primary, snapshot?.secondary].filter(validWindow);
  const weekly = w => Number.isFinite(w.windowDurationMins) && w.windowDurationMins >= 10080 && w.windowDurationMins % 10080 === 0;
  const plan = String(snapshot?.planType ?? response?.planType ?? '').toLowerCase();
  const fiveHour = windows.find(w => w.windowDurationMins === 300);
  const week = windows.find(weekly);
  const window = plan.startsWith('pro') ? week ?? fiveHour : fiveHour ?? week;
  const details = windows.map(w=>`${durationLabel(w.windowDurationMins)}：剩余 ${remainingPercent(w.usedPercent)}%${formatResetTime(w.resetsAt) ? `，${formatResetTime(w.resetsAt)} 重置` : ''}`);
  const percent = window ? remainingPercent(window.usedPercent) : null;
  return {percent, windowLabel: window && weekly(window) ? '周' : '', tone:quotaTone(percent),
    title:[window ? `当前显示：${durationLabel(window.windowDurationMins)}额度，剩余${percent}%` : '暂时无法读取 Codex 剩余用量',...details,...formatResetCredits(response)].join('\n')};
}

const hasField = (value, key) => value != null && Object.hasOwn(value, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function mergeWindow(current, patch) {
  if (patch === undefined) return current ?? null;
  if (!isRecord(patch)) return null;
  const sameWindow = current && (!Number.isFinite(patch.windowDurationMins) || current.windowDurationMins === patch.windowDurationMins);
  return sameWindow ? { ...current, ...patch } : { ...patch };
}
function mergeRateLimitSnapshot(current, patch) {
  if (patch === undefined) return current ?? null;
  if (!isRecord(patch)) return null;
  if (current?.planType && patch.planType && current.planType !== patch.planType) current = null;
  return { ...current, ...patch,
    primary: mergeWindow(current?.primary, patch.primary),
    secondary: mergeWindow(current?.secondary, patch.secondary) };
}
function mergeRateLimitsResponse(current, patch) {
  if (patch === undefined) return current ?? null;
  if (!isRecord(patch)) return null;
  // A refresh is a complete snapshot (caller passes null); notifications are deltas.
  // Never carry windows or credits across account changes.
  const changedAccount = hasField(patch, 'accountId') && hasField(current, 'accountId') && patch.accountId !== current.accountId;
  const base = changedAccount ? {} : current ?? {};
  const merged = { ...base, ...patch };
  merged.rateLimits = base.rateLimits ?? null;
  if (hasField(patch, 'rateLimits') && isCodexLimit(patch.rateLimits)) {
    merged.rateLimits = mergeRateLimitSnapshot(base.rateLimits, patch.rateLimits);
    if (isRecord(base.rateLimitsByLimitId)) merged.rateLimitsByLimitId = { ...base.rateLimitsByLimitId, codex: merged.rateLimits };
  }
  if (hasField(patch, 'rateLimitsByLimitId')) {
    if (!isRecord(patch.rateLimitsByLimitId)) {
      merged.rateLimitsByLimitId = null;
      if (!hasField(patch, 'rateLimits')) merged.rateLimits = null;
    }
    else {
      merged.rateLimitsByLimitId = { ...base.rateLimitsByLimitId, ...merged.rateLimitsByLimitId };
      for (const [id, snapshot] of Object.entries(patch.rateLimitsByLimitId)) {
        // The keyed Codex bucket is authoritative when both formats are returned.
        const previous = base.rateLimitsByLimitId?.[id] ?? (id === 'codex' ? base.rateLimits : null);
        Object.defineProperty(merged.rateLimitsByLimitId, id, {value:mergeRateLimitSnapshot(previous, snapshot),enumerable:true,configurable:true,writable:true});
      }
      if (hasField(patch.rateLimitsByLimitId, 'codex')) merged.rateLimits = merged.rateLimitsByLimitId.codex;
    }
  }
  return merged;
}
function pickCodexSnapshot(response) {
  if (!isRecord(response)) return null;
  if (hasField(response.rateLimitsByLimitId, 'codex')) {
    const keyed = response.rateLimitsByLimitId.codex;
    return isRecord(keyed) && isCodexLimit(keyed) ? keyed : null;
  }
  if (hasField(response, 'rateLimits')) return isRecord(response.rateLimits) && isCodexLimit(response.rateLimits) ? response.rateLimits : null;
  return isCodexLimit(response) ? response : null;
}

function quotaTone(percent) {
  return !Number.isFinite(percent) ? 'muted' : percent < 10 ? 'danger' : percent <= 50 ? 'warning' : 'normal';
}
function unavailableValue(current, title = '暂时无法读取 Codex 用量，正在自动重试') {
  return { ...current, percent: null, title, tone: 'muted', stale: true,
    rings: current?.rings?.map(ring => ({ ...ring, percent: null, tone: 'muted', title: `${ring.label}：暂不可用` })) ?? null };
}
function formatRateLimits(response) {
  const single = formatPrimaryRateLimits(response);
  single.tone = quotaTone(single.percent);
  const snapshot = pickCodexSnapshot(response);
  const planType = String(snapshot?.planType ?? response?.planType ?? '').toLowerCase();
  if (planType !== 'plus') return { ...single, mode: 'single', rings: null };
  const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean);
  function ring(key, label, match) {
    const window = windows.find(match);
    const percent = validWindow(window) ? remainingPercent(window.usedPercent) : null;
    const reset = formatResetTime(window?.resetsAt);
    const tone = quotaTone(percent);
    return { key, label, percent, tone,
      title: `${label}：${percent === null ? '暂不可用' : `剩余 ${percent}%`}${reset ? `，${reset} 重置` : ''}` };
  }
  const rings = [
    ring('five-hour', '5h额度', w => w.windowDurationMins === 300),
    ring('weekly', '周额度', w => Number.isFinite(w.windowDurationMins) && w.windowDurationMins >= 10080 && w.windowDurationMins % 10080 === 0)
  ];
  return { ...single, mode: 'dual', rings,
    title: ['Plus 剩余额度', ...rings.map(r => r.title), ...formatResetCredits(response)].join('\n') };
}

class AppServerClient extends require('node:events').EventEmitter {
  constructor({command='codex', args=['app-server'], requestTimeoutMs=10000}={}) {
    super(); Object.assign(this,{command,args,requestTimeoutMs});
    this.child=null; this.lines=null; this.pending=new Map(); this.serial=0; this.rateLimits=null; this.refreshPatches=null;
  }
  async start() {
    if (this.child) return;
    const child=require('node:child_process').spawn(this.command,this.args,{stdio:['pipe','pipe','pipe'],windowsHide: true,env:process.env});
    this.child=child;
    const fail=error=>{
      if (this.child!==child) return;
      this.stop(); this.emit('server-exit',error);
    };
    child.once('error',fail);
    child.once('exit',(code)=>fail(new Error(`App Server exited (${code})`)));
    child.stdin.on('error',fail);
    child.stderr.resume(); // Drain without recording account/server details.
    this.lines=require('node:readline').createInterface({input:child.stdout});
    this.lines.on('line',line=>{
      let message; try { message=JSON.parse(line); } catch { return; }
      if (!message || typeof message!=='object') return;
      const request=this.pending.get(message.id);
      if (request) {
        this.pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error.message || 'App Server request failed')) : request.resolve(message.result);
      } else if(message.method==='account/rateLimits/updated') {
        this.applyRateLimitsNotification(message.params);
      }
    });
    await this.request('initialize',{clientInfo:{name:'codex_usage_badge',title:'Codex Usage Badge',version:AGENT_VERSION}});
    this.child?.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    await this.refresh();
  }
  request(method,params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('App Server is not running'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out`));},this.requestTimeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n',error=>{
        if(error && this.pending.delete(id)){clearTimeout(timer);reject(error);}
      });
    });
  }
  applyRateLimitsNotification(patch) {
    if (!isRecord(patch)) return;
    this.refreshPatches?.push(patch);
    this.rateLimits = mergeRateLimitsResponse(this.rateLimits, patch);
    this.emit('rate-limits', this.rateLimits);
  }
  async refresh() {
    const patches = [];
    this.refreshPatches = patches;
    try {
      let snapshot = mergeRateLimitsResponse(null, await this.request('account/rateLimits/read'));
      for (const patch of patches) snapshot = mergeRateLimitsResponse(snapshot, patch);
      this.rateLimits = snapshot;
      this.emit('rate-limits', snapshot);
      return snapshot;
    } finally {
      if (this.refreshPatches === patches) this.refreshPatches = null;
    }
  }
  stop() {
    const child=this.child; this.child=null;
    this.lines?.close(); this.lines=null;
    if(child && !child.killed) child.kill();
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('App Server stopped'));}
    this.pending.clear();
  }
}

function installUsageBadge(countTokens) {
  const VERSION = 71;
  const KEY = '__codexUsageBadge';
  if (window[KEY]?.version === VERSION && window[KEY]?.scope === 'quota-and-speed') {
    window[KEY].place();
    return;
  }
  window[KEY]?.destroy?.();
  const badge = document.createElement('div');
  badge.id = 'codex-usage-badge';
  badge.tabIndex = 0;
  badge.setAttribute('role', 'meter');
  badge.setAttribute('aria-valuemin', '0');
  badge.setAttribute('aria-valuemax', '100');
  badge.setAttribute('aria-describedby', 'codex-usage-tooltip');
  function meterMarkup(suffix = '') {
    return `<svg class="usage-ring" viewBox="0 0 36 36" aria-hidden="true">
    <defs><linearGradient id="codex-usage-ring-gradient${suffix}" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop class="usage-gradient-start" offset="0%"/><stop class="usage-gradient-end" offset="100%"/>
    </linearGradient></defs>
    <circle class="usage-ring-track" cx="18" cy="18" r="14"/>
    <circle class="usage-ring-value" cx="18" cy="18" r="14" pathLength="100"/>
  </svg><span class="usage-number">—</span><span class="usage-window"></span>`;
  }
  const primaryMeter = document.createElement('div');
  primaryMeter.className = 'usage-primary';
  primaryMeter.innerHTML = meterMarkup();
  const secondaryMeter = document.createElement('div');
  secondaryMeter.className = 'usage-secondary';
  secondaryMeter.innerHTML = meterMarkup('-weekly');
  secondaryMeter.hidden = true;
  const speedMeter = document.createElement('div');
  speedMeter.className = 'usage-speed';
  speedMeter.innerHTML = `<span class="speed-dial">
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <circle class="speed-track" cx="18" cy="18" r="14"/>
      <circle class="speed-value" cx="18" cy="18" r="14" pathLength="100"/>
    </svg>
    <span class="usage-number"></span>
  </span><span class="usage-window">tok/s</span>`;
  const speedNumber = speedMeter.querySelector('.usage-number');
  speedNumber.textContent = '—';
  speedMeter.setAttribute('aria-label', '实时输出：等待正文');
  speedMeter.hidden = true;
  const cacheMeter = document.createElement('div');
  cacheMeter.className = 'usage-cache';
  cacheMeter.innerHTML = meterMarkup('-cache');
  cacheMeter.querySelector('.usage-window').textContent = '缓存';
  cacheMeter.setAttribute('aria-label', '缓存命中率：等待用量数据');
  cacheMeter.hidden = true;
  const contextMeter = document.createElement('div');
  contextMeter.className = 'usage-context';
  contextMeter.innerHTML = meterMarkup('-context');
  contextMeter.querySelector('.usage-window').textContent = '上下文';
  contextMeter.setAttribute('aria-label', '当前会话上下文：暂无数据');
  contextMeter.hidden = true;
  badge.append(primaryMeter, secondaryMeter, contextMeter, speedMeter, cacheMeter);
  const tooltip = document.createElement('div');
  tooltip.id = 'codex-usage-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const style = document.createElement('style');
  style.id = 'codex-usage-badge-style';
  const darkPalette = `
      --usage-normal-color: #12f594; --usage-normal-soft: #25d887; --usage-normal-track: #1c6349;
      --usage-warning-color: #ffd279; --usage-warning-soft: #e8aa4c; --usage-warning-track: #69522e;
      --usage-danger-color: #ff9587; --usage-danger-soft: #e76964; --usage-danger-track: #683e3b;
      --usage-muted-color: #9caaa2; --usage-muted-soft: #7b8981; --usage-muted-track: #505853;
      --usage-text: #f5f7f5; --usage-label: #b6bbb7;
  `;
  style.textContent = `
    #codex-usage-badge {
      --usage-normal-color: #0b805b; --usage-normal-soft: #168e65; --usage-normal-track: #d7e7df;
      --usage-warning-color: #9e6c14; --usage-warning-soft: #b8811c; --usage-warning-track: #efe5cf;
      --usage-danger-color: #bc4744; --usage-danger-soft: #d45d56; --usage-danger-track: #f1ddda;
      --usage-muted-color: #77858e; --usage-muted-soft: #8c979f; --usage-muted-track: #e0e5e8;
      --usage-text: #25313a; --usage-label: #65737c;
      --usage-color: var(--usage-normal-color); --usage-soft: var(--usage-normal-soft);
      --usage-ring-track: var(--usage-normal-track);
      --usage-width: 42px; --usage-ring-size: 34px;
      position: fixed; z-index: 2147482900; box-sizing: border-box; width: var(--usage-width); height: auto;
      align-self: center; margin: 0 0 2px; padding: 4px 0;
      display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 7px;
      border: 0; outline: none; color: var(--usage-text);
      background-color: inherit; background-image: none;
      box-shadow: none;
      cursor: default; user-select: none;
      -webkit-app-region: no-drag; font-family: inherit;
      font-variant-numeric: tabular-nums; line-height: 1;
    }
    #codex-usage-badge[hidden], #codex-usage-tooltip[hidden] { display: none !important; }
    #codex-usage-badge .usage-primary, #codex-usage-badge .usage-secondary, #codex-usage-badge .usage-cache, #codex-usage-badge .usage-context {
      position: relative; box-sizing: border-box; width: 100%; flex: 0 0 47px;
      display: flex; flex-direction: column; align-items: center; padding: 35px 0 0; gap: 0;
    }
    #codex-usage-badge .usage-primary[hidden], #codex-usage-badge .usage-secondary[hidden] { display: none !important; }
    #codex-usage-badge .usage-cache {
      --usage-color: #4572b8; --usage-soft: #6288c5; --usage-ring-track: #dbe5f2;
    }
    html.dark #codex-usage-badge .usage-cache, html[data-theme="dark"] #codex-usage-badge .usage-cache {
      --usage-color: #9dbef2; --usage-soft: #8cb1ed; --usage-ring-track: #44566f;
    }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) #codex-usage-badge .usage-cache {
        --usage-color: #9dbef2; --usage-soft: #8cb1ed; --usage-ring-track: #44566f;
      }
    }
    #codex-usage-badge .usage-speed { width: 100%; flex: 0 0 47px; display: flex; flex-direction: column; align-items: center; gap: 1px; }
    #codex-usage-badge .speed-dial { position: relative; width: var(--usage-ring-size); height: var(--usage-ring-size); display: grid; place-items: center; }
    #codex-usage-badge .speed-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    #codex-usage-badge .speed-track { fill: none; stroke: var(--usage-muted-track); stroke-width: 4.4; }
    #codex-usage-badge .speed-value {
      fill: none; stroke: var(--usage-normal-color); stroke-width: 4.8; stroke-linecap: round;
      transform: rotate(-90deg); transform-origin: 18px 18px;
      stroke-dasharray: 100; stroke-dashoffset: 100; transition: stroke-dashoffset 240ms ease;
    }
    #codex-usage-badge .speed-dial .usage-number { position: relative; font-size: 10px; letter-spacing: -.3px; }
    #codex-usage-badge .usage-speed[hidden], #codex-usage-badge .usage-cache[hidden], #codex-usage-badge .usage-context[hidden] { display: none; }
    #codex-usage-badge .usage-secondary {
      --usage-color: var(--usage-normal-color); --usage-soft: var(--usage-normal-soft);
      --usage-ring-track: var(--usage-normal-track);
    }
    #codex-usage-badge:hover { background-color: color-mix(in srgb, var(--usage-text) 5%, transparent); border-radius: 10px; }
    #codex-usage-badge:focus-visible { outline: 1px solid var(--usage-color); outline-offset: 2px; }
    #codex-usage-badge .usage-ring {
      display: block; position: absolute;
      width: var(--usage-ring-size); height: var(--usage-ring-size);
      top: 0;
      left: 50%; transform: translateX(-50%); overflow: visible;
    }
    #codex-usage-badge .usage-ring circle { fill: none; stroke-width: 4.4; }
    #codex-usage-badge .usage-ring circle.usage-ring-value { stroke-width: 4.8; }
    #codex-usage-badge .usage-ring-track { stroke: var(--usage-ring-track); }
    #codex-usage-badge .usage-gradient-start { stop-color: var(--usage-soft); }
    #codex-usage-badge .usage-gradient-end { stop-color: var(--usage-color); }
    #codex-usage-badge .usage-ring-value {
      stroke: url(#codex-usage-ring-gradient); stroke-linecap: round;
      transform: rotate(-90deg); transform-origin: 18px 18px;
      stroke-dasharray: 100; stroke-dashoffset: 100; opacity: 0;
      filter: none;
      transition: stroke-dashoffset 240ms ease;
    }
    #codex-usage-badge .usage-secondary .usage-ring-value { stroke: url(#codex-usage-ring-gradient-weekly); }
    #codex-usage-badge .usage-cache .usage-ring-value { stroke: url(#codex-usage-ring-gradient-cache); }
    #codex-usage-badge .usage-context .usage-ring-value { stroke: url(#codex-usage-ring-gradient-context); }
    #codex-usage-badge .usage-number { font-size: 10px; line-height: 14px; font-weight: 700; letter-spacing: -.3px; white-space: nowrap; }
    #codex-usage-badge .usage-primary .usage-number, #codex-usage-badge .usage-secondary .usage-number,
    #codex-usage-badge .usage-cache .usage-number, #codex-usage-badge .usage-context .usage-number { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); }
    #codex-usage-badge .usage-window { font-size: 8.5px; line-height: 10px; font-weight: 400; color: var(--usage-label); white-space: nowrap; }
    #codex-usage-badge[data-tone="warning"], #codex-usage-badge .usage-secondary[data-tone="warning"] { --usage-color: var(--usage-warning-color); --usage-soft: var(--usage-warning-soft); --usage-ring-track: var(--usage-warning-track); }
    #codex-usage-badge[data-tone="danger"], #codex-usage-badge .usage-secondary[data-tone="danger"] { --usage-color: var(--usage-danger-color); --usage-soft: var(--usage-danger-soft); --usage-ring-track: var(--usage-danger-track); }
    #codex-usage-badge[data-tone="muted"], #codex-usage-badge .usage-secondary[data-tone="muted"] { --usage-color: var(--usage-muted-color); --usage-soft: var(--usage-muted-soft); --usage-ring-track: var(--usage-muted-track); }
    html.dark #codex-usage-badge, html[data-theme="dark"] #codex-usage-badge { ${darkPalette} }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) #codex-usage-badge { ${darkPalette} }
    }
    #codex-usage-tooltip {
      box-sizing: border-box; position: fixed; z-index: 2147483000;
      width: 300px; max-width: calc(100vw - 16px); padding: 16px;
      border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 10px;
      background: var(--color-surface-elevated-secondary, #f8f8f7);
      color: var(--color-text-primary, #303630);
      box-shadow: 0 6px 22px #0002; pointer-events: none;
      font: 12px/1.65 -apple-system, BlinkMacSystemFont, sans-serif;
      white-space: normal; overflow-wrap: anywhere; -webkit-app-region: no-drag;
      opacity: 0; transform: translateY(3px);
      transition: opacity 140ms ease, transform 140ms ease;
    }
    #codex-usage-tooltip[data-open="true"] { opacity: 1; transform: translateY(0); }
    #codex-usage-tooltip .usage-tooltip-title { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
    #codex-usage-tooltip .usage-tooltip-sections { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 14px; }
    #codex-usage-tooltip[data-mode="dual"] .usage-tooltip-sections { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #codex-usage-tooltip .usage-tooltip-section { min-width: 0; }
    #codex-usage-tooltip .usage-tooltip-label { color: color-mix(in srgb, currentColor 75%, transparent); font-size: 11px; line-height: 16px; font-weight: 500; }
    #codex-usage-tooltip .usage-tooltip-percent { margin: 4px 0; color: color-mix(in srgb, currentColor 60%, transparent); font-size: 26px; line-height: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
    #codex-usage-tooltip .usage-tooltip-reset, #codex-usage-tooltip .usage-tooltip-status { color: color-mix(in srgb, currentColor 65%, transparent); font-size: 11px; line-height: 1.5; white-space: pre-line; }
    #codex-usage-tooltip .usage-tooltip-metadata { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); color: color-mix(in srgb, currentColor 65%, transparent); font-size: 11px; white-space: pre-line; }
    #codex-usage-tooltip .usage-metrics { display: grid; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
    #codex-usage-tooltip .usage-metric { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    #codex-usage-tooltip .usage-metric-label { color: color-mix(in srgb, currentColor 70%, transparent); font-size: 11px; }
    #codex-usage-tooltip .usage-metric-value { font-size: 12px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    #codex-usage-tooltip .usage-metric-detail { color: color-mix(in srgb, currentColor 65%, transparent); font-size: 10px; text-align: right; }
    #codex-usage-tooltip .usage-models { margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
    #codex-usage-tooltip .usage-models-title { font-size: 11px; color: color-mix(in srgb, currentColor 65%, transparent); font-weight: 600; }
    #codex-usage-tooltip .usage-model { margin-top: 10px; }
    #codex-usage-tooltip .usage-model-name { font-size: 12px; font-weight: 600; }
    #codex-usage-tooltip .usage-model-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 7px; }
    #codex-usage-tooltip .usage-model-cell { min-width: 0; }
    #codex-usage-tooltip .usage-model-label, #codex-usage-tooltip .usage-model-count { color: color-mix(in srgb, currentColor 60%, transparent); font-size: 11px; line-height: 16px; }
    #codex-usage-tooltip .usage-model-rate { font-size: 14px; line-height: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
    html.dark #codex-usage-tooltip, html[data-theme="dark"] #codex-usage-tooltip {
      background: var(--color-surface-elevated-secondary, #2c2e2c);
      color: var(--color-text-primary, #edf0ed);
    }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) #codex-usage-tooltip {
        background: var(--color-surface-elevated-secondary, #2c2e2c); color: var(--color-text-primary, #edf0ed);
      }
    }
    @media (prefers-reduced-motion: reduce) { #codex-usage-badge .usage-ring-value, #codex-usage-badge .speed-value, #codex-usage-tooltip { transition: none; } }
  `;
  let value = { percent: null, title: '正在读取 Codex 剩余用量', tone: 'muted', windowLabel: '', mode: 'single', rings: null };
  let placementTimer = null;
  let hoverTimer = null;
  let hideTimer = null;
  let closeTimer = null;
  let tooltipDesiredOpen = false;
  let rail = null;
  let footer = null;
  let mountReason = 'not-placed';
  let lastBadgeRect = null;
  let disposed = false;
  const nativeOverlaySelector = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [popover]';
  let observedOverlayNodes = new Set();
  const owned = el => !!el && [badge, tooltip, style].some(surface => surface === el || surface.contains(el));
  // A dead agent must not leave a healthy-looking quota indefinitely.
  function expireValue() {
    if (disposed || value.stale || !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt < 150000) return;
    value = { ...value, stale: true, percent: null, tone: 'muted', title: '用量数据已过期，正在等待重新连接',
      rings: value.rings?.map(ring => ({ ...ring, percent: null, tone: 'muted', title: `${ring.label}：暂不可用` })) ?? null };
    render();
  }
  const freshnessTimer = setInterval(expireValue, 1000);
  const visible = (el) => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!Number.isFinite(r.x+r.y+r.width+r.height) || r.width <= 0 || r.height <= 0 ||
        r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    for (let node=el; node && node.nodeType === 1; node=node.parentElement) {
      const css=getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' ||
          Number(css.opacity) <= 0.001) return false;
      if (node !== el) {
        const bounds=node.getBoundingClientRect();
        if (['hidden','clip','auto','scroll'].includes(css.overflowY) &&
            (r.top < bounds.top || r.bottom > bounds.bottom)) return false;
        if (['hidden','clip','auto','scroll'].includes(css.overflowX) &&
            (r.left < bounds.left || r.right > bounds.right)) return false;
      }
    }
    return true;
  };
  function nativeOverlayOpen(surface = 'badge') {
    return [...document.querySelectorAll(nativeOverlaySelector)].some(el => {
      if (owned(el) || !el.isConnected) return false;
      const r=el.getBoundingClientRect();
      if (!Number.isFinite(r.x+r.y+r.width+r.height) || r.width <= 0 || r.height <= 0) return false;
      let left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
      for (let node=el; node && node.nodeType === 1; node=node.parentElement) {
        const css=getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity) <= 0.001) return false;
        if (node !== el) {
          const clip=node.getBoundingClientRect();
          if (['hidden','clip','auto','scroll'].includes(css.overflowX)) { left=Math.max(left,clip.left);right=Math.min(right,clip.right); }
          if (['hidden','clip','auto','scroll'].includes(css.overflowY)) { top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom); }
        }
      }
      const rect = surface === 'tooltip'
        ? (!tooltip.hidden ? tooltip.getBoundingClientRect() : null)
        : (!badge.hidden ? badge.getBoundingClientRect() : lastBadgeRect);
      return rect && rect.width > 0 && rect.height > 0 &&
        right > Math.max(left, rect.left) && left < Math.min(right, rect.right) &&
        bottom > Math.max(top, rect.top) && top < Math.min(bottom, rect.bottom);
    });
  }
  function yieldToNativeOverlay() {
    if (nativeOverlayOpen()) {
      mountReason='occluded-or-clipped';
      badge.hidden=true;
      hideTooltip(true);
      return true;
    }
    if (!tooltip.hidden && nativeOverlayOpen('tooltip')) hideTooltip(true);
    return false;
  }
  function watchNativeOverlays() {
    const nodes=new Set([document.body]);
    for (const el of document.querySelectorAll(nativeOverlaySelector)) {
      if (owned(el)) continue;
      for (let node=el; node && node !== document.documentElement; node=node.parentElement) nodes.add(node);
    }
    if (nodes.size === observedOverlayNodes.size && [...nodes].every(node=>observedOverlayNodes.has(node))) return;
    observedOverlayNodes=nodes;
    overlayAttributeObserver.disconnect();
    // Discover newly assigned overlay roles without observing every host style mutation.
    overlayAttributeObserver.observe(document.documentElement,{attributes:true,subtree:true,attributeFilter:['role','popover','open']});
    for (const node of nodes) overlayAttributeObserver.observe(node,{attributes:true,attributeFilter:['class','style','hidden','aria-hidden','open','data-state']});
  }
  function badgeVisible() {
    if (badge.hidden || !visible(badge) || badge.parentElement !== document.body || nativeOverlayOpen()) return false;
    const r=badge.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
    const hitBadge=(x,y)=>{const top=document.elementFromPoint(x,y);return !!top && (top === badge || badge.contains(top));};
    // Check edges as well as the center; inset corners respect the card's rounded border.
    const cx=r.left+r.width/2, cy=r.top+r.height/2, corner=8;
    if (![[cx,cy],[cx,r.top+1],[cx,r.bottom-1],[r.left+1,cy],[r.right-1,cy],
      [r.left+corner,r.top+corner],[r.right-corner,r.top+corner],
      [r.left+corner,r.bottom-corner],[r.right-corner,r.bottom-corner]].every(([x,y])=>hitBadge(x,y))) return false;
    // A thin portal can miss all sample points. Check each external body layer at
    // the intersection of its full rectangle with the card, without reading its content.
    for (const layer of document.body.children) {
      if (owned(layer) || !visible(layer)) continue;
      const lr=layer.getBoundingClientRect(), left=Math.max(r.left,lr.left), right=Math.min(r.right,lr.right),
        top=Math.max(r.top,lr.top), bottom=Math.min(r.bottom,lr.bottom);
      if (right > left && bottom > top && !hitBadge((left+right)/2,(top+bottom)/2)) return false;
    }
    return true;
  }
  function hideTooltip(immediate = false) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    hoverTimer = null;
    hideTimer = null;
    tooltipDesiredOpen = false;
    tooltip.dataset.open = 'false';
    if (tooltip.hidden) return;
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      tooltip.hidden = true;
    } else {
      closeTimer = setTimeout(() => { tooltip.hidden = true; }, 140);
    }
  }
  function scheduleHideTooltip() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (badge.matches(':hover') || badge.matches(':focus-visible')) return;
      hideTooltip();
    }, 100);
  }
  function positionTooltip() {
    if (yieldToNativeOverlay()) return;
    const r = badge.getBoundingClientRect();
    const activeMeter = primaryMeter.hidden ? secondaryMeter : primaryMeter;
    const ringRect = activeMeter.querySelector('.usage-ring').getBoundingClientRect();
    const ringCenterY = ringRect.top + ringRect.height / 2;
    tooltip.style.left = `${Math.max(8, Math.min(r.right + 12, innerWidth - tooltip.offsetWidth - 8))}px`;
    const top = Math.max(8, Math.min(ringCenterY - tooltip.offsetHeight / 2, innerHeight - tooltip.offsetHeight - 8));
    tooltip.style.top = `${top}px`;
  }
  function showTooltip() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    if (yieldToNativeOverlay() || badge.hidden || !visible(badge) || document.hidden || disposed) return;
    tooltip.hidden = false;
    tooltipDesiredOpen = true;
    positionTooltip();
    requestAnimationFrame(() => {
      if (!disposed && tooltipDesiredOpen && !tooltip.hidden) tooltip.dataset.open = 'true';
    });
  }
  function scheduleTooltip() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    hoverTimer = setTimeout(showTooltip, 100);
  }
  function usageRingColor(percent) {
    const start = percent >= 50 ? [59, 130, 246] : [239, 68, 68];
    const end = percent >= 50 ? [34, 197, 94] : [59, 130, 246];
    const progress = percent >= 50 ? (percent - 50) / 50 : percent / 50;
    // Interpolate in linear light so intermediate colors retain their brightness.
    const linear = channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return `rgb(${start.map((channel, index) => {
      const mixed = linear(channel) + (linear(end[index]) - linear(channel)) * progress;
      return Math.round(255 * (mixed <= 0.0031308 ? mixed * 12.92 : 1.055 * mixed ** (1 / 2.4) - 0.055));
    }).join(', ')})`;
  }
  function renderMeter(element, meter, accessible = true) {
    const rawPercent = Number.isFinite(meter.percent) ? Math.max(0, Math.min(100, meter.percent)) : null;
    const percent = rawPercent === null ? null : Math.round(rawPercent);
    const number = rawPercent === null ? '—' : String(element === cacheMeter ? Math.floor(rawPercent) : percent);
    element.dataset.tone = meter.tone;
    if (element.querySelector('.usage-window').textContent !== meter.label) element.querySelector('.usage-window').textContent = meter.label;
    if (element.querySelector('.usage-number').textContent !== number) element.querySelector('.usage-number').textContent = number;
    const ring = element.querySelector('.usage-ring-value');
    ring.style.stroke = percent === null ? '' : usageRingColor(percent);
    ring.style.strokeDashoffset = String(100 - (rawPercent ?? 0));
    ring.style.opacity = percent !== null && percent > 0 ? '1' : '0';
    if (accessible) {
      element.setAttribute('role', 'meter');
      element.setAttribute('aria-label', meter.label);
      element.setAttribute('aria-valuemin', '0'); element.setAttribute('aria-valuemax', '100');
      element.setAttribute('aria-valuetext', meter.title);
      if (percent === null) element.removeAttribute('aria-valuenow');
      else element.setAttribute('aria-valuenow', String(percent));
    } else {
      for (const attr of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) element.removeAttribute(attr);
    }
  }
  const sessions = new Map();
  let liveSpeed = null;
  let liveSpeedDetails = null;
  let latestCache = null;
  let latestContext = null;
  let displayedThreadId = null;
  const cacheByThread = new Map();
  const contextByThread = new Map();

  function selectedThreadId() {
    const row = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"], [data-app-action-sidebar-thread-id][aria-current="true"]');
    const reference = row?.getAttribute('data-app-action-sidebar-thread-id') ?? '';
    const match = reference.match(/^(?:local:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (match) return match[1].toLowerCase();
    return `${location.pathname}${location.search}${location.hash}`
      .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1].toLowerCase() ?? null;
  }

  function updateDisplayedCache() {
    const threadId = selectedThreadId();
    const next = threadId ? cacheByThread.get(threadId) ?? null : null;
    const context = threadId ? contextByThread.get(threadId) ?? null : null;
    if (threadId === displayedThreadId && next === latestCache && context === latestContext) return;
    displayedThreadId = threadId;
    latestCache = next;
    latestContext = context;
    const usedPercent = context ? context.used / context.limit * 100 : null;
    renderMeter(contextMeter, { percent: usedPercent, label: '上下文',
      tone: usedPercent === null ? 'muted' : usedPercent >= 90 ? 'danger' : usedPercent >= 75 ? 'warning' : 'normal',
      title: context ? `当前会话上下文已用 ${usedPercent.toFixed(1)}%` : '当前会话暂无上下文数据' });
    const cachePercent = next ? next.cached / next.input * 100 : null;
    const detail = cachePercent === null ? '当前会话暂无缓存数据'
      : `当前会话最近请求缓存命中率 ${Math.min(cachePercent < 100 ? 99.99 : 100, cachePercent).toFixed(2)}%`;
    renderMeter(cacheMeter, { percent: cachePercent, label: '缓存', tone: next ? 'normal' : 'muted', title: detail });
    cacheMeter.querySelector('.usage-ring-value').style.stroke = 'var(--usage-color)';
    renderTooltip(value.mode === 'dual' && value.rings?.length === 2);
  }

  function liveSpeedDescription() {
    return liveSpeed === null ? '实时活动：等待输出' : `实时活动：${liveSpeed.toFixed(1)} tok/s（圆环刻度 150）`;
  }

  function newSession(turnId) {
    return { turnId, budget: 0, moment: 0, debt: 0, rate: 0, queue: [0, 0, 0, 0, 0],
      lastTick: 0, lastActivity: 0, lastSettlement: 0, provisional: 0,
      finish: null, stopped: false, display: 0, totalOutput: null };
  }

  function allocate(session, amount, horizon) {
    if (amount < 0) {
      const removed = Math.min(session.budget, -amount);
      if (session.budget > 0) session.moment *= 1 - removed / session.budget;
      session.budget -= removed;
      session.debt += -amount - removed;
    } else {
      const repaid = Math.min(session.debt, amount);
      session.debt -= repaid;
      const quantity = amount - repaid;
      session.budget += quantity;
      session.moment += quantity * horizon;
    }
  }

  function advance(session, now) {
    if (session.stopped || now - session.lastActivity >= 20 ||
        (session.finish !== null && now >= session.finish + 5)) {
      session.budget = 0;
      session.moment = 0;
      session.rate = 0;
      session.queue = [0, 0, 0, 0, 0];
      session.display = 0;
      session.lastTick = Math.floor(now);
      return;
    }
    if (!session.lastTick) session.lastTick = Math.floor(now);
    while (session.lastTick + 1 <= now) {
      session.lastTick += 1;
      const horizon = session.budget > 0 ? Math.max(1, session.moment / session.budget) : 1;
      const target = session.budget / horizon;
      session.rate += (target - session.rate) * (target >= session.rate ? 0.28 : 0.18);
      const quantity = Math.min(session.budget, Math.max(0, session.rate));
      if (session.budget > 0) session.moment *= 1 - quantity / session.budget;
      session.budget -= quantity;
      for (const [index, weight] of [1, 2, 3, 2, 1].entries()) session.queue[index] += quantity * weight / 9;
      session.display = session.queue.shift();
      session.queue.push(0);
      if (session.finish !== null && session.lastTick > session.finish + 3) {
        const fraction = Math.min(1, Math.max(0, (session.finish + 5 - session.lastTick) / 2));
        session.display *= fraction * fraction * (3 - 2 * fraction);
      }
    }
  }

  function refreshSpeed() {
    updateDisplayedCache();
    const now = performance.now() / 1000;
    let total = 0;
    for (const [threadId, session] of sessions) {
      advance(session, now);
      total += session.display;
      if (now - session.lastActivity > 60) sessions.delete(threadId);
    }
    const rate = total > 0 ? total : null;
    if (rate === liveSpeed) return;
    liveSpeed = rate;
    speedNumber.textContent = rate === null ? '—' : String(Math.round(rate));
    speedMeter.querySelector('.speed-value').style.strokeDashoffset = String(100 - Math.min(rate ?? 0, 150) / 150 * 100);
    speedMeter.setAttribute('aria-label', liveSpeedDescription());
    if (liveSpeedDetails) liveSpeedDetails.textContent = rate === null ? '等待输出' : `${rate.toFixed(1)} tok/s`;
  }

  function onOutputNotification(event) {
    if (event.data?.type !== 'mcp-notification') return;
    const { method, params, hostId } = event.data;
    if (method === 'account/rateLimits/updated' && (!hostId || hostId === 'local') && params) {
      window.__codexUsageBadgeQuotaUpdated?.(JSON.stringify(params));
    }
    const now = performance.now() / 1000;
    const threadId = params?.threadId;
    let session = sessions.get(threadId);
    if (method === 'turn/started' && threadId) {
      const previousTotal = session?.totalOutput ?? null;
      session = newSession(params.turn?.id);
      session.totalOutput = previousTotal;
      session.lastActivity = now;
      sessions.set(threadId, session);
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = params?.tokenUsage?.last;
      if (typeof threadId === 'string' && Number.isFinite(usage?.inputTokens) && usage.inputTokens > 0 &&
          Number.isFinite(usage.cachedInputTokens) && usage.cachedInputTokens >= 0) {
        cacheByThread.set(threadId.toLowerCase(), { input: usage.inputTokens, cached: Math.min(usage.cachedInputTokens, usage.inputTokens) });
        updateDisplayedCache();
      }
      const limit = params?.tokenUsage?.modelContextWindow;
      const used = usage?.totalTokens;
      if (typeof threadId === 'string' && Number.isFinite(limit) && limit > 0 &&
          Number.isFinite(used) && used >= 0) {
        contextByThread.set(threadId.toLowerCase(), { used, limit });
        updateDisplayedCache();
      }
      const totalOutput = params?.tokenUsage?.total?.outputTokens;
      if (session && Number.isFinite(totalOutput)) {
        advance(session, now);
        if (session.totalOutput !== null && totalOutput >= session.totalOutput) {
          const output = totalOutput - session.totalOutput;
          allocate(session, output - session.provisional, Math.max(1, session.lastSettlement ? now - session.lastSettlement : 1));
          session.provisional = 0;
          session.lastSettlement = now;
          session.lastActivity = now;
        }
        if (session.totalOutput === null) session.provisional = 0;
        session.totalOutput = totalOutput;
      }
    } else if (method === 'item/agentMessage/delta' && threadId && params.delta) {
      if (!session || (params.turnId && session.turnId && params.turnId !== session.turnId)) {
        session = newSession(params.turnId);
        sessions.set(threadId, session);
      }
      advance(session, now);
      const tokens = countTokens(params.delta);
      session.provisional += tokens;
      allocate(session, tokens, 1);
      session.lastActivity = now;
      session.stopped = false;
    } else if (method === 'turn/completed' && session) {
      advance(session, now);
      const status = params.turn?.status;
      if (status === 'interrupted' || status === 'failed') session.stopped = true;
      else session.finish = now;
      refreshSpeed();
    }
  }

  const speedTimer = setInterval(refreshSpeed, 500);
  window.addEventListener('message', onOutputNotification);

  function renderTooltip(dual) {
    const lines = String(value.title ?? '').split('\n');
    const heading = document.createElement('div');
    heading.className = 'usage-tooltip-title';
    heading.textContent = 'Codex 用量';
    const details = !dual && !value.stale ? lines.slice(1).map(line => {
      const match = line.match(/^([^：]+)：剩余\s*(\d+)%(?:，.+)?$/);
      return match ? { label: match[1], percent: Number(match[2]), title: line } : null;
    }).filter(Boolean) : [];
    const meters = dual ? value.rings : details.length ? details : [{ ...value,
      label: primaryMeter.querySelector('.usage-window').textContent }];
    const sections = document.createElement('div');
    sections.className = 'usage-tooltip-sections';
    const metadata = lines.slice(1).filter(line => !meters.some(meter => meter.title === line));
    const speedDetails = document.createElement('div');
    speedDetails.textContent = liveSpeedDescription();
    tooltip.dataset.mode = meters.length > 1 ? 'dual' : 'single';
    for (const meter of meters) {
      const section = document.createElement('div');
      section.className = 'usage-tooltip-section';
      const label = document.createElement('div');
      label.className = 'usage-tooltip-label';
      label.textContent = meter.label;
      const percent = Number.isFinite(meter.percent) ? Math.max(0, Math.min(100, Math.round(meter.percent))) : null;
      const percentage = document.createElement('div');
      percentage.className = 'usage-tooltip-percent';
      percentage.textContent = percent === null ? '—' : `${percent}%`;
      if (percent !== null) percentage.style.color = usageRingColor(percent);
      section.append(label, percentage);
      const title = String(meter.title ?? '');
      const reset = title.match(/，(.+?)\s+重置$/);
      if (reset) {
        const resetText = document.createElement('div');
        resetText.className = 'usage-tooltip-reset';
        resetText.textContent = `${reset[1]} 重置`;
        section.appendChild(resetText);
      }
      if (percent === null && title.startsWith(`${meter.label}：`)) {
        const status = document.createElement('div');
        status.className = 'usage-tooltip-status';
        status.textContent = title.slice(meter.label.length + 1, reset ? reset.index : undefined);
        section.appendChild(status);
      } else if (!/^[^：]+：剩余\s*\d+%(?:，.+\s+重置)?$/.test(title) && title !== lines[0] && title !== value.title) {
        metadata.push(title);
      }
      sections.appendChild(section);
    }
    tooltip.replaceChildren(heading, sections);
    const footer = document.createElement('div');
    footer.className = 'usage-tooltip-metadata';
    for (const text of metadata) {
      const line = document.createElement('div');
      line.textContent = text;
      footer.appendChild(line);
    }
    if (metadata.length) tooltip.appendChild(footer);
    const metrics = document.createElement('div');
    metrics.className = 'usage-metrics';
    const speedRow = document.createElement('div');
    speedRow.className = 'usage-metric';
    const speedLabel = document.createElement('span');
    speedLabel.className = 'usage-metric-label';
    speedLabel.textContent = '实时活动';
    speedDetails.className = 'usage-metric-value';
    speedDetails.textContent = liveSpeed === null ? '等待输出' : `${liveSpeed.toFixed(1)} tok/s`;
    speedRow.append(speedLabel, speedDetails);
    const cacheRow = document.createElement('div');
    cacheRow.className = 'usage-metric';
    const cacheLabel = document.createElement('span');
    cacheLabel.className = 'usage-metric-label';
    cacheLabel.textContent = '当前会话缓存';
    const cacheValue = document.createElement('span');
    cacheValue.className = 'usage-metric-value';
    cacheValue.textContent = latestCache ? `${Math.min(latestCache.cached < latestCache.input ? 99.99 : 100, latestCache.cached / latestCache.input * 100).toFixed(2)}%` : '暂无数据';
    cacheRow.append(cacheLabel, cacheValue);
    const contextRow = document.createElement('div');
    contextRow.className = 'usage-metric';
    const contextLabel = document.createElement('span');
    contextLabel.className = 'usage-metric-label';
    contextLabel.textContent = '当前会话上下文';
    const contextValue = document.createElement('span');
    contextValue.className = 'usage-metric-value';
    contextValue.textContent = latestContext ? `${(latestContext.used / latestContext.limit * 100).toFixed(1)}%` : '暂无数据';
    contextRow.append(contextLabel, contextValue);
    metrics.append(contextRow);
    if (latestContext) {
      const contextDetail = document.createElement('div');
      contextDetail.className = 'usage-metric-detail';
      contextDetail.textContent = `${latestContext.used.toLocaleString()} / ${latestContext.limit.toLocaleString()} token`;
      metrics.appendChild(contextDetail);
    }
    metrics.append(speedRow, cacheRow);
    if (latestCache) {
      const cacheDetail = document.createElement('div');
      cacheDetail.className = 'usage-metric-detail';
      cacheDetail.textContent = `${latestCache.cached.toLocaleString()} / ${latestCache.input.toLocaleString()} 输入 token`;
      metrics.appendChild(cacheDetail);
    }
    tooltip.appendChild(metrics);
    if (value.bodySpeeds?.length) {
      const models = document.createElement('div');
      models.className = 'usage-models';
      const title = document.createElement('div');
      title.className = 'usage-models-title';
      title.textContent = '模型正文速度 · tok/s';
      models.appendChild(title);
      for (const model of value.bodySpeeds) {
        const section = document.createElement('div');
        section.className = 'usage-model';
        const name = document.createElement('div');
        name.className = 'usage-model-name';
        name.textContent = model.model;
        const grid = document.createElement('div');
        grid.className = 'usage-model-grid';
        for (const [label, rate, count] of [
          ['最新', model.latest, null],
          ['15 分钟', model.mean15?.rate, model.mean15?.count],
          ['30 分钟', model.mean30?.rate, model.mean30?.count],
        ]) {
          const cell = document.createElement('div');
          cell.className = 'usage-model-cell';
          const caption = document.createElement('div');
          caption.className = 'usage-model-label';
          caption.textContent = label;
          const number = document.createElement('div');
          number.className = 'usage-model-rate';
          number.textContent = Number.isFinite(rate) ? rate.toFixed(1) : '—';
          cell.append(caption, number);
          if (count != null) {
            const detail = document.createElement('div');
            detail.className = 'usage-model-count';
            detail.textContent = `${count} 段`;
            cell.appendChild(detail);
          }
          grid.appendChild(cell);
        }
        section.append(name, grid);
        models.appendChild(section);
      }
      tooltip.appendChild(models);
    }
    liveSpeedDetails = speedDetails;
  }
  function render() {
    const dual = value.mode === 'dual' && value.rings?.length === 2;
    const percent = Number.isFinite(value.percent) ? Math.max(0, Math.min(100, Math.round(value.percent))) : null;
    badge.dataset.mode = dual ? 'dual' : 'single';
    badge.dataset.tone = dual ? value.rings[0].tone : value.tone;
    secondaryMeter.hidden = !dual;
    renderMeter(primaryMeter, dual ? value.rings[0] : {
      ...value, label: value.windowLabel === '周' ? '周额度' : percent === null ? '用量' : '5h额度'
    }, dual);
    if (dual) renderMeter(secondaryMeter, value.rings[1]);
    badge.setAttribute('role', dual ? 'group' : 'meter');
    badge.setAttribute('aria-label', 'Codex 剩余用量');
    if (dual) {
      for (const attr of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) badge.removeAttribute(attr);
    } else {
      badge.setAttribute('aria-valuemin', '0'); badge.setAttribute('aria-valuemax', '100');
      badge.setAttribute('aria-valuetext', value.title);
      if (percent === null) badge.removeAttribute('aria-valuenow');
      else badge.setAttribute('aria-valuenow', String(percent));
    }
    renderTooltip(dual);
  }
  function place() {
    if (disposed || !document.body) return;
    if (!style.isConnected) (document.head ?? document.documentElement).appendChild(style);
    if (!badge.isConnected || badge.parentElement !== document.body) document.body.appendChild(badge);
    if (!tooltip.isConnected) document.body.appendChild(tooltip);
    watchNativeOverlays();
    if (yieldToNativeOverlay()) return;

    // Never add children to the framework-owned navigation rail: it can alter
    // :nth-child selectors, flex layout, avatar dimensions and React reconciliation.
    // Measure even after a previous fail-closed hide; never depend on stale zero-size bounds.
    badge.hidden=false;
    const navs=[...document.querySelectorAll('nav[data-app-navigation-rail]')];
    let target=null, failure=navs.length ? 'no-valid-footer' : 'no-visible-rail';
    for (const nav of navs) {
      const nr=nav.getBoundingClientRect();
      if (!visible(nav) || nr.width < 30 || nr.width > 110) continue;
      const candidates=[...nav.children].filter(child=>{
        if (!visible(child) || getComputedStyle(child).position === 'absolute') return false;
        const identity=child.querySelector('[aria-label*="profile" i], [aria-label*="account" i], [aria-label*="avatar" i], [aria-label*="账户"], [aria-label*="头像"], [aria-label*="个人"], [data-testid*="profile" i], [data-testid*="account" i], img[alt*="avatar" i]');
        return !!identity;
      });
      if (candidates.length !== 1) continue;
      const foot=candidates[0], fr=foot.getBoundingClientRect();
      if (!visible(foot) || fr.top <= nr.top || fr.bottom > nr.bottom+2) continue;
      const controls = [...nav.querySelectorAll('button,a,input,[role="button"],[tabindex]')]
        .filter(el => !foot.contains(el) && visible(el)).map(el => el.getBoundingClientRect());
      const layouts = [[true, true, true, false], [true, false, true, false], [true, false, false, false], [false, false, false, false]];
      if (value.mode === 'dual' && value.rings?.[1]?.key === 'weekly') layouts.push([false, false, false, true]);
      for (const [showContext, showSpeed, showCache, weeklyOnly] of layouts) {
        primaryMeter.hidden = weeklyOnly;
        contextMeter.hidden = !showContext;
        speedMeter.hidden = !showSpeed;
        cacheMeter.hidden = !showCache;
        const br = badge.getBoundingClientRect(), gap = 4;
        const left = Math.round(nr.left + (nr.width - br.width) / 2);
        const top = Math.round(fr.top - br.height - gap);
        if (top < nr.top + gap || left < 0 || left + br.width > innerWidth || top + br.height > innerHeight) continue;
        const collides = controls.some(r => r.left < left + br.width + 2 && r.right > left - 2 &&
          r.top < top + br.height + 2 && r.bottom > top - 2);
        if (collides) continue;
        target = {nav, foot, left, top};
        break;
      }
      if (target) break;
      failure = 'no-safe-space';
    }
    // Keep watching the actual rail even when its footer temporarily disappears:
    // attribute-only recovery (display/hidden/class) must cause a new placement.
    const watchedRail=target?.nav ?? navs.find(nav=>{const r=nav.getBoundingClientRect();return visible(nav) && r.width>=30 && r.width<=110;}) ?? null;
    if (rail !== watchedRail || footer !== (target?.foot ?? null)) {
      if (rail) resizeObserver.unobserve(rail);
      if (footer) resizeObserver.unobserve(footer);
      rail=watchedRail;footer=target?.foot ?? null;
      hostAttributeObserver.disconnect();
      if (rail) {
        resizeObserver.observe(rail);
        if (footer) resizeObserver.observe(footer);
        hostAttributeObserver.observe(rail,{attributes:true,subtree:true,attributeFilter:['class','style','hidden','aria-hidden']});
      }
    }
    if (!target) {
      mountReason=failure;
      badge.hidden=true;hideTooltip();return;
    }
    badge.style.left=target.left+'px';
    badge.style.top=target.top+'px';
    badge.hidden=false;
    lastBadgeRect = badge.getBoundingClientRect();
    mountReason=badgeVisible() ? 'mounted' : 'occluded-or-clipped';
    if (mountReason !== 'mounted') { badge.hidden=true;hideTooltip(); }
    else if (!tooltip.hidden) positionTooltip();
  }
  function schedulePlacement() {
    if (disposed || placementTimer !== null) return;
    placementTimer = setTimeout(() => { placementTimer = null; place(); }, 100);
  }
  const observer = new MutationObserver(records => {
    if (records.some(r => !owned(r.target))) { yieldToNativeOverlay(); schedulePlacement(); }
  });
  const resizeObserver = new ResizeObserver(schedulePlacement);
  const hostAttributeObserver = new MutationObserver(schedulePlacement);
  const overlayAttributeObserver = new MutationObserver(records => {
    if (records.some(r=>!owned(r.target))) { yieldToNativeOverlay(); schedulePlacement(); }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  badge.addEventListener('mouseenter', scheduleTooltip);
  badge.addEventListener('mouseleave', scheduleHideTooltip);
  badge.addEventListener('focus', showTooltip);
  badge.addEventListener('blur', scheduleHideTooltip);
  const onKeyDown = e => {
    if (yieldToNativeOverlay() || badge.hidden || !visible(badge)) return;
    if (e.key === 'Escape') hideTooltip();
  };
  badge.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', schedulePlacement);
  window.addEventListener('scroll', schedulePlacement, true);
  const onNativeToggle = event => { if (!owned(event.target)) { yieldToNativeOverlay(); schedulePlacement(); } };
  document.addEventListener('toggle', onNativeToggle, true);
  const onVisibilityChange = () => { if (document.hidden) hideTooltip(true); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window[KEY] = {
    version: VERSION,
    scope: 'quota-and-speed',
    place,
    update(next) { value = { ...value, ...next }; expireValue(); render(); place(); },
    status() {
      return { version: VERSION, placed: mountReason === 'mounted' && badgeVisible(), mountReason: mountReason === 'mounted' && !badgeVisible() ? 'occluded-or-clipped' : mountReason,
        percent: value.percent, windowLabel: value.windowLabel, tone: value.tone, mode: value.mode, rings: value.rings,
        updatedAt: value.updatedAt ?? null, stale: value.stale ?? false,
        badgeCount: document.querySelectorAll('#codex-usage-badge').length };
    },
    destroy() {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      hostAttributeObserver.disconnect();
      overlayAttributeObserver.disconnect();
      clearTimeout(placementTimer);
      clearInterval(freshnessTimer);
      clearInterval(speedTimer);
      window.removeEventListener('message', onOutputNotification);
      hideTooltip(true);
      window.removeEventListener('resize', schedulePlacement);
      window.removeEventListener('scroll', schedulePlacement, true);
      document.removeEventListener('toggle', onNativeToggle, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      badge.remove(); tooltip.remove(); style.remove();
      delete window[KEY];
    }
  };
  render();
  place();
}

function isMainWindow(target) {
  try {
    const u=new URL(target?.url || '');
    return u.protocol==='app:' && u.hostname==='-' && u.pathname==='/index.html' && !/overlay/i.test(decodeURIComponent(u.search+u.hash));
  } catch {return false;}
}
function buildBootstrapScript() {
  const fs = require('node:fs');
  const path = require('node:path');
  const tokenizer = fs.readFileSync(path.join(__dirname, 'badge-tokenizer.cjs'), 'utf8');
  return `(() => { ${tokenizer}\n(${installUsageBadge.toString()})(badgeTokenizer.countTokens); })()`;
}
class CdpSession {
  constructor(target, onRateLimits) {this.target=target;this.onRateLimits=onRateLimits;this.pending=new Map();this.serial=0;this.socket=null;}
  async connect() {
    let u;
    try {u=new URL(this.target.webSocketDebuggerUrl);}
    catch {throw new Error('CDP must use loopback WebSocket port 39222');}
    if(u.protocol!=='ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.port!=='39222') throw new Error('CDP must use loopback WebSocket port 39222');
    const ws=new WebSocket(u);this.socket=ws;
    ws.addEventListener('message',event=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__codexUsageBadgeQuotaUpdated') {
        try { this.onRateLimits?.(JSON.parse(msg.params.payload)); } catch {}
        return;
      }
      const p=this.pending.get(msg?.id);if(!p)return;
      this.pending.delete(msg.id);clearTimeout(p.timer);
      msg.error || msg.result?.exceptionDetails ? p.reject(new Error('CDP evaluation failed')) : p.resolve(msg.result);
    });
    ws.addEventListener('close',()=>this.rejectPending());
    ws.addEventListener('error',()=>this.rejectPending());
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.close();reject(new Error('CDP handshake timed out'));},4000);
      const finish=fn=>{clearTimeout(timer);fn();};
      ws.addEventListener('open',()=>finish(resolve),{once:true});
      ws.addEventListener('error',()=>finish(()=>reject(new Error('CDP unavailable'))),{once:true});
      ws.addEventListener('close',()=>finish(()=>reject(new Error('CDP closed'))),{once:true});
    });
    await this.request('Runtime.enable');
    await this.request('Runtime.addBinding', { name: '__codexUsageBadgeQuotaUpdated' });
  }
  request(method,params={}) {
    if(this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('CDP disconnected'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP request timed out'));},5000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}));}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  evaluate(expression){return this.request('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});}
  rejectPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'));}this.pending.clear();}
  close(){this.rejectPending();this.socket?.close();this.socket=null;}
}
class RendererInjector {
  constructor({port}){if(port!==39222)throw new Error('CDP must use port 39222');this.port=39222;this.sessions=new Map();this.mountStatus=new Map();this.currentValue=null;this.scanning=false;this.stopped=false;}
  async scan(){
    if(this.scanning||this.stopped)return;
    this.scanning=true;
    try{
      const res=await fetch('http://127.0.0.1:39222/json/list',{signal:AbortSignal.timeout(3000)});
      if(!res.ok)throw new Error('CDP unavailable');
      const pages=(await res.json()).filter(t=>t.type==='page'&&isMainWindow(t)&&typeof t.webSocketDebuggerUrl==='string');
      const live=new Set(pages.map(t=>t.id));
      for(const[id,s]of this.sessions)if(!live.has(id)){s.close();this.sessions.delete(id);this.mountStatus.delete(id);}
      await Promise.all(pages.map(async t=>{
        const existing=this.sessions.get(t.id), session=existing || new CdpSession(t, patch => this.onRateLimits?.(patch));
        try{
          if(!existing)await session.connect();
          const version = await session.evaluate('window.__codexUsageBadge?.version');
          if (version?.result?.value !== 71) await session.evaluate(buildBootstrapScript());
          if(this.currentValue)await session.evaluate(`window.__codexUsageBadge?.update(${JSON.stringify(this.currentValue)})`);
          // CDP success is NOT UI acceptance. Query the mounted, visible Ring separately
          // and retain only a fixed reason code (never host DOM, paths or account text).
          const checked=(await session.evaluate('window.__codexUsageBadge?.status() ?? null'))?.result?.value;
          const allowed=new Set(['mounted','not-placed','no-visible-rail','no-valid-footer','no-safe-space','occluded-or-clipped']);
          const mounted=checked?.placed === true && checked?.badgeCount === 1 && checked?.version === 71;
          const reason=mounted?'mounted':allowed.has(checked?.mountReason)?checked.mountReason:'no-verified-ui';
          this.mountStatus.set(t.id,{mounted,reason});
          if(this.stopped){session.close();return;}
          this.sessions.set(t.id,session);
        }catch{session.close();this.sessions.delete(t.id);this.mountStatus.delete(t.id);}
      }));
    }finally{this.scanning=false;}
  }
  async update(value){
    this.currentValue=value;
    await Promise.all([...this.sessions].map(async([id,s])=>{
      try{await s.evaluate(`window.__codexUsageBadge?.update(${JSON.stringify(value)})`);}catch{s.close();this.sessions.delete(id);this.mountStatus.delete(id);}
    }));
  }
  stop(){this.stopped=true;for(const s of this.sessions.values())s.close();this.sessions.clear();this.mountStatus.clear();}
}

const resolverFs = require('node:fs');
function isExecutableFile(file) {
  if (!file) return false;
  try {
    resolverFs.accessSync(file, resolverFs.constants.X_OK);
    return resolverFs.statSync(file).isFile();
  } catch { return false; }
}
function resolveCodexBin(explicit, appPath = '/Applications/ChatGPT.app', platform = process.platform) {
  if (explicit && explicit !== 'codex' && isExecutableFile(explicit)) return explicit;
  // New desktop releases bundle the CLI as a nested app and expose a shell entrypoint.
  // Prefer this client's CLI to unrelated installations in the user's shell PATH.
  const candidates = platform === 'win32' ? windowsCodexCandidates(appPath) : [
    `${appPath}/Contents/Resources/codex-cli/bin/codex`,
    `${appPath}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`,
    `${appPath}/Contents/Resources/codex`
  ];
  const found = candidates.find(isExecutableFile);
  if (!found) throw new Error('找不到客户端内置 Codex 可执行程序，请检查客户端安装');
  return found;
}
function windowsCodexCandidates(appPath) {
  const path = require('node:path');
  const root = /\.exe$/i.test(appPath) ? path.dirname(appPath) : appPath;
  const local = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
  const managed = path.join(local, 'OpenAI', 'Codex', 'bin');
  let versions = [];
  try {
    versions = resolverFs.readdirSync(managed, { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => path.join(managed, e.name, 'codex.exe')).filter(isExecutableFile)
      .sort((a, b) => resolverFs.statSync(b).mtimeMs - resolverFs.statSync(a).mtimeMs);
  } catch {}
  return [path.join(managed, 'codex.exe'), ...versions,
    path.join(root, 'resources', 'codex.exe'), path.join(root, 'resources', 'codex-cli', 'bin', 'codex.exe'),
    path.join(root, 'resources', 'codex-cli', 'codex.exe')];
}

var AGENT_VERSION = '1.0.2';
function parseArgs(argv) {
  const options = {
    port: Number(process.env.CODEX_BADGE_PORT) || 39222,
    appPath: process.env.CODEX_BADGE_APP || (process.platform === 'win32' ? '' : '/Applications/ChatGPT.app'),
    codexBin: process.env.CODEX_BADGE_BIN || 'codex',
    pollMs: Number(process.env.CODEX_BADGE_POLL_MS) || 15000
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--app') options.appPath = argv[++i];
    else if (argv[i] === '--codex-bin') options.codexBin = argv[++i];
    else if (argv[i] === '--poll-ms') options.pollMs = Math.max(1000, Number(argv[++i]));
  }
  return options;
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function readBodySpeeds() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const directory = path.join(require('node:os').homedir(), 'Library', 'Application Support', 'CodexTokenBar');
  const files = await fs.readdir(directory).catch(() => []);
  const now = Date.now() / 1000;
  const samples = [];
  for (const file of files.filter(name => /^observed-speed-.*\.json$/.test(name))) {
    const entries = await fs.readFile(path.join(directory, file), 'utf8').then(JSON.parse).catch(() => []);
    if (!Array.isArray(entries)) continue;
    for (const sample of entries) {
      const { model, outputTokens, durationSeconds, tokensPerSecond, startedAt, endedAt } = sample;
      if (sample.measurementKind !== 'completed_body' || sample.tokenizer !== 'o200k_base' ||
          typeof model !== 'string' || !model.trim() || model.trim().toLowerCase() === 'unknown' ||
          !Number.isFinite(outputTokens) || outputTokens <= 0 ||
          !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
          !Number.isFinite(startedAt) || !Number.isFinite(endedAt) ||
          !Number.isFinite(tokensPerSecond) || endedAt < now - 1800 || endedAt > now ||
          Math.round(endedAt * 1000) - Math.round(startedAt * 1000) <= 400 ||
          Math.abs(endedAt - startedAt - durationSeconds) > 0.01 ||
          Math.abs(outputTokens / durationSeconds - tokensPerSecond) > Math.max(0.01, tokensPerSecond * 0.001) ||
          tokensPerSecond < 2 || tokensPerSecond > 500 || sample.networkWarning != null) continue;
      samples.push(sample);
    }
  }
  const groups = new Map();
  for (const sample of samples) {
    const group = groups.get(sample.model) ?? [];
    group.push(sample);
    groups.set(sample.model, group);
  }
  return [...groups].map(([model, group]) => {
    group.sort((a, b) => b.endedAt - a.endedAt);
    const average = entries => {
      if (!entries.length) return null;
      const tokens = entries.reduce((sum, entry) => sum + entry.outputTokens, 0);
      const seconds = entries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
      return { rate: tokens / seconds, count: entries.length };
    };
    return { model, latest: group[0].tokensPerSecond, endedAt: group[0].endedAt,
      mean15: average(group.filter(entry => entry.endedAt >= now - 900)), mean30: average(group) };
  }).sort((a, b) => b.endedAt - a.endedAt);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
  log(`codex-usage-card v${AGENT_VERSION} started: local quota connection; no in-app version checks.`);

  const injector = new RendererInjector({ port: options.port });
  let stopped = false;
  let client = null;
  let pending = false;
  let nextRead = 0;
  let failures = 0;
  let connected = false;
  let mounted = false;
  let bodySpeeds = [];
  injector.onRateLimits = patch => {
    if (client && !stopped) client.applyRateLimitsNotification(patch);
  };

  injector.currentValue = {
    percent: null,
    title: '正在读取 Codex 剩余用量',
    tone: 'muted',
    windowLabel: ''
  };

  const scan = async () => {
    if (stopped) return;
    try {
      await injector.scan();
      const hasSession = injector.sessions.size > 0;
      const hasMountedRing = [...(injector.mountStatus?.values?.() ?? [])].some(status => status?.mounted === true);
      if (!connected && hasSession) log('主窗口 CDP 已连接（不代表 Ring 已显示）。');
      if (!mounted && hasMountedRing) log('Ring 已挂载并确认可见。');
      if (mounted && !hasMountedRing) log(`Ring 挂载状态已失效：${[...injector.mountStatus.values()].map(status => status.reason).join(', ') || '窗口未连接'}。`);
      connected = hasSession;
      mounted = hasMountedRing;
    } catch {
      connected = false;
      mounted = false;
      for (const session of injector.sessions.values()) session.close();
      injector.sessions.clear();
      injector.mountStatus?.clear?.();
    }

    if (injector.sessions.size === 0) {
      const old = client;
      client = null;
      old?.stop();
      nextRead = 0;
      injector.currentValue = unavailableValue(injector.currentValue);
    }
  };

  async function readUsage() {
    if (stopped || pending || Date.now() < nextRead || injector.sessions.size === 0) return;
    pending = true;

    try {
      if (!client) {
        options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
        const current = new AppServerClient({
          command: options.codexBin,
          debug: false
        });
        client = current;

        current.on('rate-limits', data => {
          if (client !== current || stopped) return;
          try {
            injector.update({
              ...formatRateLimits(data),
              bodySpeeds,
              updatedAt: Date.now(),
              stale: false
            }).catch(() => {});
          } catch {
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });

        current.on('server-exit', () => {
          if (client === current) {
            client = null;
            nextRead = Date.now() + 10000;
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });

        await current.start();
        if (stopped) current.stop();
      } else {
        await client.refresh();
      }

      failures = 0;
      if (client) nextRead = Date.now() + options.pollMs;
    } catch {
      const old = client;
      client = null;
      old?.stop();
      failures++;
      nextRead = Date.now() + Math.min(60000, 10000 * failures);
      await injector.update(unavailableValue(injector.currentValue));
    } finally {
      pending = false;
    }
  }

  const tick = async () => {
    await scan();
    if (injector.sessions.size > 0) {
      const next = await readBodySpeeds();
      if (JSON.stringify(next) !== JSON.stringify(bodySpeeds)) {
        bodySpeeds = next;
        await injector.update({ ...injector.currentValue, bodySpeeds });
      }
    }
    readUsage().catch(() => {});
  };

  let ticking = false;
  const guardedTick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await tick();
    } catch {
      // Keep the monitor silent on transient local connection failures.
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(guardedTick, 5000);

  const shutdown = () => {
    stopped = true;
    clearInterval(timer);
    const old = client;
    client = null;
    old?.stop();
    injector.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await guardedTick();
}

module.exports = {
  installUsageBadge,
  formatRateLimits,
  mergeRateLimitsResponse,
  buildBootstrapScript,
  unavailableValue,
  isMainWindow,
  resolveCodexBin,
  readBodySpeeds,
  AppServerClient,
  RendererInjector,
  main
};

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
