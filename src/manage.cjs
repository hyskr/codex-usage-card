// Installation/explicit launch operations are deliberately separate from agent.cjs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { resolveCodexBin, isMainWindow, installUsageBadge } = require('./agent.cjs');
const {cleanupLegacyLauncher}=require('./macos/shortcuts.cjs');
const {acquireLock,rejectAutomaticUpdate,disableOwnedUpdates,ownedSnapshot,inspectOwnedUpdates}=require('./updater/core.cjs');
const VERSION='1.0.0';
const AUTO_UPDATE=false;
const home = os.homedir();
const app = process.env.CODEX_BADGE_APP || ['/Applications/Codex.app','/Applications/ChatGPT.app',path.join(home,'Applications/Codex.app'),path.join(home,'Applications/ChatGPT.app')].find(candidate => { try { resolveCodexBin(undefined,candidate); return true; } catch { return false; } }) || '/Applications/Codex.app';
const node = process.execPath;
const installDir = path.join(home, 'Library/Application Support/CodexUsageBadge');
const logs = path.join(home, 'Library/Logs');
const label = 'com.codexusagebadge.agent';
const activationLabel = 'com.codexusagebadge.activate-once';
const startupLabel='com.codexusagebadge.startup';
const updaterLabel='com.codexusagebadge.updater';
const gui = `gui/${process.getuid()}`;
const plistPath = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
const startupPlist=path.join(home,'Library/LaunchAgents',startupLabel+'.plist');
const updaterPlist=path.join(home,'Library/LaunchAgents',updaterLabel+'.plist');
const startupDir=path.join(installDir,'startup-helper');
const packagedBridge=path.join(__dirname,'macos/startup/bridge');
const bridgeSource=fs.existsSync(packagedBridge)?packagedBridge:path.join(__dirname,'.devtools/macos-startup-bridge');
const runtimeFiles={'agent.cjs':path.join(__dirname,'agent.cjs'),'badge-tokenizer.cjs':path.join(__dirname,'badge-tokenizer.cjs'),'manage.cjs':path.join(__dirname,'manage.cjs'),'macos/shortcuts.cjs':path.join(__dirname,'macos/shortcuts.cjs'),'macos/compatibility.cjs':path.join(__dirname,'macos/compatibility.cjs'),'macos/compatibility.json':path.join(__dirname,'macos/compatibility.json'),'startup-helper/bridge':bridgeSource,'startup-helper/controller.cjs':path.join(__dirname,'macos/startup/controller.cjs'),'startup-helper/watch.cjs':path.join(__dirname,'macos/startup/watch.cjs'),'updater/core.cjs':path.join(__dirname,'updater/core.cjs'),'updater/worker.cjs':path.join(__dirname,'updater/worker.cjs'),'updater/run.sh':path.join(__dirname,'updater/run.sh')};
const launcher = path.join(home, 'Applications/Codex 用量条.app');
const desktopLauncher = path.join(home, 'Desktop/Codex 用量条.app');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
function xml(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  if (value && typeof value === 'object') return `<dict>${Object.entries(value).map(([k,v]) => `<key>${escapeXml(k)}</key>${xml(v)}`).join('')}</dict>`;
  return `<string>${escapeXml(value)}</string>`;
}
function escapeXml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function writePlist(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`, {mode:0o644});
  command('/usr/bin/plutil', ['-lint', file]);
}
function loaded(job) { try { return command('/bin/launchctl',['print',`${gui}/${job}`]); } catch { return null; } }
async function stop(job) {
  if (!loaded(job)) return;
  command('/bin/launchctl', ['bootout', `${gui}/${job}`]);
  for(let i=0;i<30;i++) { if(!loaded(job)) return; await pause(100); }
  throw new Error(`后台任务未能停止：${job}`);
}
function quoteShell(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function agentConfig() {
  return {
    Label: label, ProgramArguments: [node, path.join(installDir,'agent.cjs')],
    EnvironmentVariables: { ...(process.env.CODEX_HOME ? {CODEX_HOME:process.env.CODEX_HOME} : {}), CODEX_BADGE_APP:app, CODEX_BADGE_BIN:resolveCodexBin(undefined,app), CODEX_BADGE_PORT:'39222', CODEX_BADGE_DEBUG:'0' },
    RunAtLoad:true, KeepAlive:{SuccessfulExit:false}, ThrottleInterval:10, ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.out.log'), StandardErrorPath:path.join(logs,'CodexUsageBadge.err.log')
  };
}
function activationConfig({waitForExit=false}={}) {
  return {
    Label:activationLabel, ProgramArguments:[node,path.join(installDir,'manage.cjs'),...(waitForExit?['activate-after-exit']:['activate'])],
    RunAtLoad:true, KeepAlive:false, ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.activate.log'), StandardErrorPath:path.join(logs,'CodexUsageBadge.activate.err.log')
  };
}
function statOrNull(file) { try { return fs.lstatSync(file); } catch (error) { if(error.code==='ENOENT')return null; throw error; } }
function ownedLauncher() {
  const stat=statOrNull(launcher);
  if(!stat)return false;
  if(stat.isSymbolicLink()||!stat.isDirectory())return false;
  try { return command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(launcher,'Contents/Info.plist')]).trim()==='local.codexusagebadge.launcher'; }
  catch { return false; }
}
function ownedShortcut() {
  const stat=statOrNull(desktopLauncher);
  return !!stat?.isSymbolicLink()&&fs.readlinkSync(desktopLauncher)===launcher;
}
function startupConfig() {
  return {Label:startupLabel,ProgramArguments:[node,path.join(startupDir,'watch.cjs')],RunAtLoad:true,
    KeepAlive:{SuccessfulExit:false},ThrottleInterval:10,ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.startup.out.log'),StandardErrorPath:path.join(logs,'CodexUsageBadge.startup.err.log')};
}
function updaterConfig(){
  return {Label:updaterLabel,ProgramArguments:['/bin/bash',path.join(installDir,'updater/run.sh'),'run'],
    EnvironmentVariables:{CODEX_BADGE_APP:app,CODEX_BADGE_NODE:node},RunAtLoad:true,StartInterval:21600,ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.updater.out.log'),StandardErrorPath:path.join(logs,'CodexUsageBadge.updater.err.log')};
}
function inspectStartupSettings() {
  const snapshot=ownedSnapshot(path.join(startupDir,'settings.json'),{allowMissing:true});
  const settings=snapshot.exists?JSON.parse(snapshot.read().toString('utf8')):null;
  if(snapshot.exists&&(!settings||typeof settings!=='object'||Array.isArray(settings)||settings.owner!=='codex-usage-badge-startup-v1'))throw new Error('启动助手目录已被其他程序占用');
  const allowClientRestart=!settings||!Object.hasOwn(settings,'allowClientRestart')||settings.allowClientRestart===true;
  return {snapshot,allowClientRestart};
}
function assertClientControlAllowed() {
  if(inspectStartupSettings().allowClientRestart)return;
  const error=new Error('手动验收模式禁止自动退出、打开或聚焦 Codex；请由用户手动操作。');
  error.code='ERR_MANUAL_TEST_CLIENT_CONTROL';throw error;
}
// Only the plist emitted by the reviewed historical installer is supported.
function legacyUpdaterPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(updaterConfig())}</plist>\n`;
}
function migrationFailure(phase,state={settingsDisabled:false,taskStopped:false,plistQuarantined:false}) {
  const message=phase==='validation'
    ? '旧自动更新迁移校验失败，未开始迁移；请运行 node manage.cjs status，人工核对配置和任务归属后重试。'
    : `旧自动更新迁移执行失败，安装或卸载已中止；设置${state.settingsDisabled?'已关闭':'状态未确认'}，任务${state.taskStopped?'已停止':'状态未确认'}，plist${state.plistQuarantined?'已隔离':'隔离未确认'}。${state.quarantine?`隔离核查位置（相对安装目录）：${state.quarantine}。`:''}请运行 node manage.cjs status 并人工核查；不要重新加载旧 updater。`;
  const error=new Error(message);
  error.code=phase==='validation'?'ERR_UPDATER_MIGRATION_VALIDATION':'ERR_UPDATER_MIGRATION_EXECUTION';
  error.migrationState={...state};return error;
}
function verifyUpdaterTask(output) {
  if(typeof output!=='string'||output.length>1024*1024||/[\x00-\x08\x0b-\x1f\x7f]/.test(output.replaceAll('\r\n','\n')))throw Error('invalid task output');
  const lines=output.replaceAll('\r\n','\n').trim().split('\n');
  if(lines.shift()?.trim()!==`${gui}/${updaterLabel} = {`||lines.pop()?.trim()!=='}')throw Error('unrecognized task');
  const config=updaterConfig(),expectedEnvironment=config.EnvironmentVariables;
  const exact=value=>actual=>actual===value;
  // Known execution fields must match the reviewed plist; unknown fields fail closed.
  const scalarRules=new Map([
    ['path',exact(updaterPlist)],['program',exact('/bin/bash')],['label',exact(updaterLabel)],['type',exact('LaunchAgent')],
    ['stdout path',exact(config.StandardOutPath)],['stderr path',exact(config.StandardErrorPath)],
    ['run interval',exact(`${config.StartInterval} seconds`)],
    ['state',value=>['running','not running','waiting','spawn scheduled','exited'].includes(value)],
    ['last exit code',value=>/^(?:-?\d+|\(never exited\))$/.test(value)],
    ['last terminating signal',value=>/^\d+$/.test(value)]
  ]);
  // These named counters describe runtime observations, not alternate job configuration.
  for(const key of ['active count','runs','pid','forks','execs','asid'])scalarRules.set(key,value=>/^\d+$/.test(value));
  for(const key of ['initialized','trampolined','started suspended','proxy started suspended'])scalarRules.set(key,value=>/^[01]$/.test(value));
  const values=new Map(),blocks=new Map(),args=[];let section=null,argumentIndent=null;
  // launchctl(1) setenv/config describe context-wide/default environment; plist
  // EnvironmentVariables is job-specific. Shared values affect processes but do
  // not establish job ownership or substitute for its required CODEX fields.
  // print is not a stable API: only this explicit, flat schema is supported.
  const environmentBlocks=new Set(['environment','inherited environment','default environment']);
  for(const line of lines) {
    if(section==='arguments') {
      // The supported fixture uses the block header's exact indentation for each
      // argument and closing brace. Never infer indentation from argument data.
      if(line===argumentIndent+'}') {section=null;argumentIndent=null;continue;}
      if(!line.startsWith(argumentIndent))throw Error('ambiguous task argument boundary');
      const argument=line.slice(argumentIndent.length);
      if(!argument||/[{}\x00-\x1f\x7f]/.test(argument))throw Error('invalid task argument');
      args.push(argument);continue;
    }
    // Strip display indentation only; trailing argument/value bytes are identity data.
    const text=line.replace(/^[ \t]*/,'');if(!text)continue;
    if(/[\x00-\x1f\x7f]/.test(text))throw Error('invalid task text');
    if(text==='}') {if(section===null)throw Error('invalid task nesting');section=null;continue;}
    if(section!==null) {
      if(/[{}]/.test(text))throw Error('nested task configuration');
      const match=/^([A-Za-z_][A-Za-z_0-9]*) =>(?: (.*))?$/.exec(text),environment=blocks.get(section);
      if(!match||environment.has(match[1]))throw Error('invalid task environment');
      environment.set(match[1],match[2]??'');
      continue;
    }
    const block=/^([^={}]+?) = \{$/.exec(text);
    if(block) {
      const key=block[1];
      if(values.has(key)||blocks.has(key)||key!=='arguments'&&!environmentBlocks.has(key))throw Error('unrecognized task block');
      section=key;blocks.set(key,new Map());
      if(key==='arguments')argumentIndent=line.slice(0,line.length-text.length);
      continue;
    }
    if(/[{}]/.test(text))throw Error('invalid task text');
    const match=/^([^=]+?) = (.*)$/.exec(text),rule=match&&scalarRules.get(match[1]);
    if(!rule||values.has(match[1])||blocks.has(match[1])||!rule(match[2]))throw Error('unrecognized task field');
    values.set(match[1],match[2]);
  }
  const environment=blocks.get('environment');
  if(section!==null||values.get('path')!==updaterPlist||values.get('program')!=='/bin/bash'||
    JSON.stringify(args)!==JSON.stringify(config.ProgramArguments)||!environment||
    Object.entries(expectedEnvironment).some(([key,value])=>environment.get(key)!==value)||
    [...environment].some(([key,value])=>!Object.hasOwn(expectedEnvironment,key)&&(key!=='XPC_SERVICE_NAME'||value!==updaterLabel)))throw Error('task identity mismatch');
}
function updaterTaskLoaded() {
  let output;
  try { output=command('/bin/launchctl',['print',`${gui}/${updaterLabel}`]); }
  catch(error) {
    const missing=`Could not find service "${updaterLabel}" in domain for user gui: ${process.getuid()}`;
    const message=String(error.stderr??'').replaceAll('\r','').trim();
    if(error.status===113&&(message===missing||message==='Bad request.\n'+missing))return false;
    throw Error('updater query unconfirmed');
  }
  verifyUpdaterTask(output);return true;
}
const updaterQuarantineProofs=new WeakMap();
function verifyQuarantinedPlist(state) {
  const proof=updaterQuarantineProofs.get(state);
  if(!proof||state.quarantine!==proof.relative)throw Error('unknown quarantine identity');
  const saved=ownedSnapshot(path.join(installDir,proof.relative));
  if(['dev','ino','uid','mode','size','mtimeMs','nlink'].some(field=>saved.stat[field]!==proof.stat[field])||saved.read().toString('utf8')!==legacyUpdaterPlist())throw Error('quarantine identity changed');
  const source=ownedSnapshot(updaterPlist,{allowMissing:true});
  if(source.exists)throw Error('updater plist still present');
  source.verify();
}
function confirmMigrationState(state) {
  const current={...state};
  try { const settings=inspectOwnedUpdates(installDir);settings.verify();current.settingsDisabled=!settings.enabled; }
  catch { current.settingsDisabled=false; }
  try { current.taskStopped=!updaterTaskLoaded(); }
  catch { current.taskStopped=false; }
  if(current.quarantine) {
    current.plistQuarantined=false;
    try { verifyQuarantinedPlist(state);current.plistQuarantined=true; }
    catch {}
  }
  return current;
}
const updaterMigrationPlans=new WeakMap();
function inspectUpdaterMigration() {
  try {
    if([home,app,node,installDir,updaterPlist].some(value=>/[{}\r\n\x00]/.test(value)))throw Error('unsupported path');
    const settings=inspectOwnedUpdates(installDir,{allowMissing:true});
    const plist=ownedSnapshot(updaterPlist,{allowMissing:true});
    const quarantine=ownedSnapshot(path.join(installDir,'updater-quarantine'),{kind:'directory',allowMissing:true});
    if(quarantine.exists&&(quarantine.stat.mode&0o077)!==0)throw Error('quarantine is not private');
    const runtime=['updater/run.sh','updater/worker.cjs','updater/core.cjs'].map(name=>ownedSnapshot(path.join(installDir,name),{allowMissing:true}));
    if(plist.exists) {
      if(!settings.exists||plist.read().toString('utf8')!==legacyUpdaterPlist()||runtime.slice(0,2).some(entry=>!entry.exists))throw Error('unknown updater plist');
    }
    const loaded=updaterTaskLoaded();
    if(loaded&&!plist.exists)throw Error('loaded updater without verified plist');
    const token=Object.freeze({});
    updaterMigrationPlans.set(token,{settings,plist,quarantine,runtime,loaded});return token;
  } catch { throw migrationFailure('validation'); }
}
async function migrateUpdater(plan=inspectUpdaterMigration()) {
  const owned=updaterMigrationPlans.get(plan);
  if(!owned)throw migrationFailure('validation');
  const {settings,plist,quarantine,runtime}=owned;
  const filesValid=()=>{plist.verify();for(const entry of runtime)entry.verify();};
  try {
    settings.verify();filesValid();quarantine.verify();
    if(updaterTaskLoaded()&&!plist.exists)throw Error('unverified loaded updater');
  } catch { throw migrationFailure('validation'); }
  const state={settingsDisabled:false,taskStopped:false,plistQuarantined:false};
  try {
    let disabled;
    if(settings.exists) {
      disableOwnedUpdates(installDir,{expected:settings});
      disabled=inspectOwnedUpdates(installDir);
      if(disabled.enabled)throw Error('updates still enabled');
      disabled.verify();state.settingsDisabled=true;
    }
    filesValid();
    if(updaterTaskLoaded()) {
      if(!plist.exists||!disabled)throw Error('unverified updater stop');
      disabled.verify();filesValid();
      if(!updaterTaskLoaded())state.taskStopped=true;
      else {
        disabled.verify();filesValid();
        command('/bin/launchctl',['bootout',`${gui}/${updaterLabel}`]);
      }
      for(let attempt=0;attempt<30;attempt++) {
        if(!updaterTaskLoaded()){state.taskStopped=true;break;}
        await pause(100);
      }
      if(!state.taskStopped)throw Error('updater did not stop');
    } else state.taskStopped=true;
    if(plist.exists) {
      disabled.verify();filesValid();quarantine.verify();
      const base=path.join(installDir,'updater-quarantine');
      if(!quarantine.exists)fs.mkdirSync(base,{mode:0o700});
      const baseGuard=ownedSnapshot(base,{kind:'directory'});
      if((baseGuard.stat.mode&0o077)!==0)throw Error('quarantine is not private');
      const id=require('node:crypto').randomUUID(),directory=path.join(base,id);
      baseGuard.verify();fs.mkdirSync(directory,{mode:0o700});
      const directoryGuard=ownedSnapshot(directory,{kind:'directory'}),destination=path.join(directory,updaterLabel+'.plist');
      const destinationGuard=ownedSnapshot(destination,{allowMissing:true});
      if(destinationGuard.exists)throw Error('quarantine destination exists');
      disabled.verify();filesValid();baseGuard.verify();directoryGuard.verify();destinationGuard.verify();
      if(updaterTaskLoaded())throw Error('updater reappeared');
      // Recheck paths after the potentially blocking launchctl query, before moving anything.
      disabled.verify();filesValid();baseGuard.verify();directoryGuard.verify();destinationGuard.verify();
      state.quarantine=`updater-quarantine/${id}/${updaterLabel}.plist`;
      updaterQuarantineProofs.set(state,{relative:state.quarantine,stat:plist.stat});
      fs.renameSync(updaterPlist,destination);
      verifyQuarantinedPlist(state);state.plistQuarantined=true;
    }
    disabled?.verify();return state;
  } catch { throw migrationFailure('execution',confirmMigrationState(state)); }
}
function operationLock(){
  const lock=path.join(home,'Library/Caches/CodexUsageBadge-manage.lock');
  try { ownedSnapshot(lock,{kind:'directory',allowMissing:true}).verify(); }
  catch { throw migrationFailure('validation'); }
  return lock;
}
async function operation(fn){
  const unlock=acquireLock(operationLock());
  if(!unlock)throw Error('另一个安装、更新或卸载操作正在进行，请稍后重试');
  try{return await fn();}finally{unlock();}
}
function clientCompatibility() {
  let inspectCompatibility;
  try{({inspectCompatibility}=require('./macos/compatibility.cjs'));if(typeof inspectCompatibility!=='function')throw Error('invalid detector');}
  catch{return {status:'UNSUPPORTED',reason:'Client compatibility detection is unavailable.',client:null};}
  let cli;
  try{cli=resolveCodexBin(undefined,app);}catch{return {status:'UNSUPPORTED',reason:'The selected application has no usable Codex CLI.',client:null};}
  try{return inspectCompatibility({app,cli,exec:command,nodeVersion:process.versions.node});}
  catch{return {status:'UNSUPPORTED',reason:'Client compatibility could not be inspected safely.',client:null};}
}
async function approveClient(result,allowUnverifiedClient) {
  if(result.status==='UNSUPPORTED'){const error=new Error(result.status+': '+result.reason);error.code='ERR_CLIENT_UNSUPPORTED';throw error;}
  const {confirmCompatibility}=require('./macos/compatibility.cjs');
  if(result.client)console.log('Client compatibility: '+result.status+' — '+result.client.appName+' '+result.client.appVersion+' (build '+result.client.appBuild+') ['+result.client.bundleIdentifier+'] / '+result.client.cliVersion);
  await confirmCompatibility(result,{allowUnverifiedClient,
    interactive:process.stdin?.isTTY===true&&process.stdout?.isTTY===true,
    warn:message=>console.warn(message+' Use --allow-unverified-client for an explicit noninteractive continuation.'),
    ask:async prompt=>{
      const readline=require('node:readline/promises').createInterface({input:process.stdin,output:process.stdout});
      try{return await readline.question(prompt);}finally{readline.close();}
    }});
}
function preflight(approvedClient) {
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('需要 Node.js 24 或更高版本');
  if(!fs.existsSync(bridgeSource))throw new Error('缺少 macOS 启动助手，请下载完整安装包；源码构建需运行 scripts/build_native.py');
  for(const source of Object.values(runtimeFiles)) {
    if(!fs.existsSync(source))throw new Error('安装包不完整：'+path.basename(source));
    if(source.endsWith('.cjs'))command(node,['--check',source]);
  }
  const migration=inspectUpdaterMigration();
  inspectStartupSettings();
  const current=clientCompatibility();
  if(current.status==='UNSUPPORTED'){const error=new Error(current.status+': '+current.reason);error.code='ERR_CLIENT_UNSUPPORTED';throw error;}
  if(approvedClient&&(current.status!==approvedClient.status||JSON.stringify(current.client)!==JSON.stringify(approvedClient.client))){const error=new Error('Client compatibility changed after confirmation; inspect compatibility and retry.');error.code='ERR_CLIENT_COMPATIBILITY_CHANGED';throw error;}
  command(bridgeSource,['snapshot',app]);
  return migration;
}
function saveInstallFiles() {
  const files=[plistPath,startupPlist,...Object.keys(runtimeFiles).map(file=>path.join(installDir,file)),
    ...['状态.json','installed-version.json'].map(file=>path.join(installDir,file)),...['settings.json','state.json'].map(file=>path.join(startupDir,file))];
  const directories=new Set();
  for(const file of files) {
    ownedSnapshot(file,{allowMissing:true}).verify();
    for(let dir=path.dirname(file);dir.startsWith(installDir);dir=path.dirname(dir))if(!statOrNull(dir))directories.add(dir);
  }
  const entries=files.map(file=>{const s=statOrNull(file);if(s?.isSymbolicLink())throw new Error('安装文件不能是符号链接：'+file);return {file,mode:s?.mode,data:s?fs.readFileSync(file):null};});
  return () => {
    for(const {file,mode,data} of entries) {
      if(statOrNull(file))fs.unlinkSync(file);
      if(data!==null){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data,{mode});}
    }
    for(const dir of [...directories].sort((a,b)=>b.length-a.length)) {
      try { fs.rmdirSync(dir); } catch(error) {if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    }
  };
}
async function install({manualTest=false,allowUnverifiedClient=false}={}){
  if(process.argv.some(arg=>/^--from-update(?:=|$)/.test(arg)))rejectAutomaticUpdate();
  if(typeof manualTest!=='boolean')throw new Error('manualTest 必须是布尔值');
  if(typeof allowUnverifiedClient!=='boolean')throw new Error('allowUnverifiedClient must be a boolean');
  operationLock(); // Reject unsafe lock parents before any version-reading subprocess.
  console.log('ZIP provenance: UNVERIFIED by the installer. Verify the archive independently before executing extracted scripts.');
  const approvedClient=clientCompatibility();
  await approveClient(approvedClient,allowUnverifiedClient);
  return operation(()=>installUnlocked({manualTest,approvedClient}));
}
async function installUnlocked({manualTest,approvedClient}) {
  const migrationState=await migrateUpdater(preflight(approvedClient));
  const startupSettings=inspectStartupSettings();
  const allowClientRestart=!manualTest&&startupSettings.allowClientRestart;
  // Never restore an old updater when rolling back a private installation.
  const previousJobs=[[label,plistPath],[startupLabel,startupPlist]].filter(([job])=>loaded(job));
  let restore=()=>{};
  try {
    for(const old of [startupLabel,'com.codexusagebadge.install-once',activationLabel,label])await stop(old);
    startupSettings.snapshot.verify();
    restore=saveInstallFiles();
    fs.mkdirSync(startupDir,{recursive:true,mode:0o700});fs.mkdirSync(logs,{recursive:true});
    const installSettings=inspectOwnedUpdates(installDir,{allowMissing:true});
    if(installSettings.enabled)throw Error('unexpected enabled settings');
    for(const [name,source] of Object.entries(runtimeFiles)) {
      const target=path.join(installDir,name);fs.mkdirSync(path.dirname(target),{recursive:true});
      if(source!==target)fs.copyFileSync(source,target);
      fs.chmodSync(target,name.endsWith('/bridge')?0o700:0o600);
    }
    fs.writeFileSync(path.join(startupDir,'settings.json'),JSON.stringify({owner:'codex-usage-badge-startup-v1',app:fs.realpathSync(app),allowClientRestart})+'\n',{mode:0o600});
    writePlist(plistPath,agentConfig());writePlist(startupPlist,startupConfig());
    command('/bin/launchctl',['bootstrap',gui,plistPath]);
    const startedAt=Date.now();
    command('/bin/launchctl',['bootstrap',gui,startupPlist]);
    let ready=false;
    for(let i=0;i<100;i++) {
      await pause(200);
      try {
        const state=JSON.parse(fs.readFileSync(path.join(startupDir,'state.json'),'utf8'));
        ready=state.event===(allowClientRestart?'watching':'observing')&&state.updatedAt>=startedAt&&/state = running/.test(loaded(startupLabel)||'')&&/state = running/.test(loaded(label)||'');
      } catch {}
      if(ready)break;
    }
    if(!ready)throw new Error('启动助手未能就绪');
    const settingsFile=path.join(installDir,'update-settings.json');
    installSettings.verify();
    if(!installSettings.exists)fs.writeFileSync(settingsFile,JSON.stringify({owner:'codex-usage-badge-updater-v1',enabled:false,allowPrerelease:false})+'\n',{mode:0o600,flag:'wx'});
    const finalSettings=inspectOwnedUpdates(installDir);
    if(finalSettings.enabled)throw Error('updates unexpectedly enabled');
    finalSettings.verify();
    fs.writeFileSync(path.join(installDir,'installed-version.json'),JSON.stringify({schema:1,platform:'macOS',repository:'hyskr/codex-usage-card',version:VERSION,app:fs.realpathSync(app),codexHome:process.env.CODEX_HOME||''})+'\n',{mode:0o600});
    record({state:'installed',startupMode:allowClientRestart?'automatic':'observe',message:allowClientRestart?'自动加载已启用，下次从原客户端图标启动即可':'手动验收模式：启动助手仅观察，客户端操作由用户手动完成',updaterMigration:migrationState});
    finalSettings.verify();
  } catch(error) {
    let rollbackError;
    try {
      await stop(startupLabel);await stop(label);restore();
      // An old startup helper may ignore the observation policy. Never restart it on this rollback path.
      for(const [job,file] of previousJobs)if((allowClientRestart||job!==startupLabel)&&fs.existsSync(file))command('/bin/launchctl',['bootstrap',gui,file]);
    }catch(failure){rollbackError=failure;}
    const failure=new Error(`安装失败：${error.message}；${rollbackError?'恢复旧版程序文件失败，请人工核查后重试':'已恢复安装前的程序文件'}。${allowClientRestart?'':'为避免客户端重启，旧 startup 未自动恢复运行，请人工核查。'}自动更新安全迁移不会回退，不会重新加载旧 updater；请运行 node manage.cjs status。`);
    failure.code=rollbackError?'ERR_PRIVATE_INSTALL_ROLLBACK':'ERR_PRIVATE_INSTALL';failure.migrationState=confirmMigrationState(migrationState);throw failure;
  }
  // Installation leaves Dock, Launchpad and legacy user shortcuts unchanged.
  // Keep the legacy cleanup module for compatibility; never invoke it here.
  console.log(allowClientRestart?`已安装 v${VERSION}，自动更新已关闭。完全退出客户端后，从原来的 Codex 图标打开，等待 5–10 秒。`:`已安装 v${VERSION}（手动验收模式），自动更新已关闭。未清理 Dock/Launchpad；启动助手仅观察，不会自动退出、打开或聚焦 Codex。`);
}
async function targets() {
  const response=await fetch('http://127.0.0.1:39222/json/list',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('本机端口暂不可连接');
  return (await response.json()).filter(t=>t.type==='page'&&isMainWindow(t)&&t.webSocketDebuggerUrl);
}
async function cdp(target,method,params) {
  let endpoint;
  try { endpoint=new URL(target?.webSocketDebuggerUrl); }
  catch { throw new Error('CDP must use loopback WebSocket port 39222'); }
  if(endpoint.protocol!=='ws:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) ||
      endpoint.port!=='39222' || endpoint.username || endpoint.password) {
    throw new Error('CDP must use loopback WebSocket port 39222');
  }
  const ws=new WebSocket(endpoint);
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('窗口检查超时')),5000);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method,params})));
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('窗口连接失败'));});
      ws.addEventListener('message',event=>{
        const m=JSON.parse(event.data);if(m.id!==1)return;clearTimeout(timer);
        if(m.error||m.result?.exceptionDetails)reject(new Error('窗口检查失败'));else resolve(m.result);
      });
    });
  } finally { ws.close(); }
}
async function evaluate(target,expression) {
  return (await cdp(target,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
}
function appRunning() {
  let executable=path.basename(app,'.app');
  try { executable=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',path.join(app,'Contents/Info.plist')]).trim(); } catch {}
  return command('/bin/ps',['-Ao','comm=']).split('\n').some(s=>s.trim()===path.join(app,'Contents/MacOS',executable));
}
function record(value) {
  fs.writeFileSync(path.join(installDir,'状态.json'),JSON.stringify({time:new Date().toISOString(),version:VERSION,...value},null,2)+'\n');
}
function recordActivation(value) {
  try { record(value); } catch {
    const error=new Error('界面验收状态写入失败；请运行 node manage.cjs status 检查。');
    error.code='ERR_UI_STATUS_WRITE';throw error;
  }
}
async function waitForExit({isRunning=appRunning,sleep=pause,now=Date.now,timeoutMs=300000}={}) {
  const deadline=now()+timeoutMs;
  for(;;) {
    if(now()>=deadline)throw new Error('等待退出已结束。稍后完全退出 Codex 后，从原应用图标打开即可。');
    if(!isRunning()) {
      await sleep(500);
      if(!isRunning())return;
    }
    await sleep(250);
  }
}
async function activateAfterExit() {
  assertClientControlAllowed();
  let ready=false;
  try { ready=(await targets()).length>0; } catch {}
  if(ready) { await activate(); return; }
  recordActivation({state:'waiting_for_exit',message:'等待完全退出 Codex；退出后将自动带正确参数打开一次',expiresAt:new Date(Date.now()+300000).toISOString()});
  console.log('等待用户完全退出客户端；不主动关闭窗口，不反复唤起。');
  await waitForExit();
  await activate();
}
function expectedUiVersion() {
  // Use the exact UI bundled with this manager, including installed packages without src/.
  const match=typeof installUsageBadge==='function'&&Function.prototype.toString.call(installUsageBadge).match(/^\s*function\s+installUsageBadge\s*\(\s*countTokens\s*\)\s*\{\s*const\s+VERSION\s*=\s*(\d+)\s*;/);
  const version=match?Number(match[1]):NaN;
  if(!Number.isSafeInteger(version)||version<1)throw new Error('无法确认当前安装包的用量界面版本，未执行界面验收');
  return version;
}
function inspectUsageBadge(status,version,now=Date.now()) {
  if(!status||status.placed!==true||status.badgeCount!==1||status.version!==version)return {mounted:false};
  const meters=status.mode==='dual' ? (Array.isArray(status.rings)&&status.rings.length===2?status.rings:[]) : [{label:status.windowLabel,percent:status.percent}];
  const readings=meters.map(meter=>({label:typeof meter?.label==='string'?meter.label:'额度',
    percent:Number.isFinite(meter?.percent)&&meter.percent>=0&&meter.percent<=100?meter.percent:null}));
  const age=now-status.updatedAt;
  const fresh=!status.stale&&Number.isFinite(status.updatedAt)&&age>=0&&age<150000;
  const available=fresh?readings.filter(reading=>reading.percent!==null).length:0;
  const loading=!status.stale&&status.updatedAt==null&&readings.length>0&&readings.every(reading=>reading.percent===null);
  const usageState=loading?'loading':!available?'unavailable':available<readings.length?'partial':'ready';
  return {mounted:true,usageState,readings};
}
async function activate({allowRestart=false,foreground=false}={}) {
  assertClientControlAllowed();
  const uiVersion=expectedUiVersion();
  let ready=false;
  try { ready=(await targets()).length>0; } catch {}
  if(!ready&&appRunning()) {
    if(!allowRestart) {
      command('/usr/bin/osascript',['-e','display notification "请先完全退出 Codex，再从原应用图标打开。后台不会自动重启你的工作窗口。" with title "Codex 用量条"']);
      return;
    }
    recordActivation({state:'activating',message:'正在执行本次授权的一次重启'});
    command('/usr/bin/osascript',['-e','tell application id "com.openai.codex" to quit']);
    await waitForExit({timeoutMs:120000});
  }
  if(!ready) {
    const args=foreground?['-a',app]:['-g','-a',app];
    command('/usr/bin/open',[...args,'--args','--remote-debugging-address=127.0.0.1','--remote-debugging-port=39222']);
  } else if(foreground) {
    command('/usr/bin/open',['-a',app]); // Only a user's explicit launcher click may focus the app.
  }
  let uiWasShown=false,uiWasChecked=false;
  for(let attempt=0;attempt<45;attempt++) {
    let pages;
    try { pages=await targets(); } catch {
      await pause(2000);
      continue;
    }
    const checks=await Promise.allSettled(pages.map(async target=>({target,status:await evaluate(target,'window.__codexUsageBadge?.status() ?? null')})));
    const results=checks.filter(check=>check.status==='fulfilled').map(check=>check.value);
    if(results.length)uiWasChecked=true;
    const shown=results.map(result=>({...result,...inspectUsageBadge(result.status,uiVersion)})).filter(result=>result.mounted);
    if(shown.length)uiWasShown=true;
    if(shown.length&&/state = running/.test(loaded(label)||'')) {
      const current=shown.find(result=>result.usageState==='ready')??shown.find(result=>result.usageState==='partial')??shown[0];
      const {version,...uiStatus}=current.status;
      const state=current.usageState==='loading'?'ui_ready_waiting_for_usage':current.usageState==='unavailable'?'ui_ready_usage_unavailable':'ready';
      const message=current.usageState==='loading'?'侧栏用量悬浮条已显示，额度正在读取':current.usageState==='unavailable'?'侧栏用量悬浮条已显示，额度暂不可用':current.usageState==='partial'?'侧栏用量悬浮条已显示，部分额度可用':'侧栏用量悬浮条已显示，额度可用';
      recordActivation({...uiStatus,state,message,windows:shown.length,uiVersion,usageState:current.usageState});
      if(current.usageState==='ready'||current.usageState==='partial')console.log(`安装成功：侧栏用量悬浮条已显示，${current.readings.map(reading=>`${reading.label} ${reading.percent!==null?`剩余 ${reading.percent}%`:'暂不可用'}`).join('，')}。`);
      else console.log(`界面已就绪：${message}；请稍后查看。`);
      return;
    }
    await pause(2000);
  }
  if(uiWasShown)throw new Error('侧栏用量悬浮条已显示，但用量后台未确认运行，请运行 node manage.cjs status');
  if(!uiWasChecked)throw new Error('暂未完成侧栏界面验收：本机窗口连接暂不可用，请稍后运行 node manage.cjs status');
  throw new Error('客户端已启动，但未确认单个版本匹配的用量悬浮条已挂载，请运行 node manage.cjs status');
}
async function scheduleActivation(options={}) {
  assertClientControlAllowed();
  await stop('com.codexusagebadge.install-once');
  await stop(activationLabel);
  const file=path.join(installDir,'activate-once.plist');
  writePlist(file,activationConfig(options));
  command('/bin/launchctl',['bootstrap',gui,file]);
  console.log('单次启用任务已提交，KeepAlive=false；退出后不会重复运行。');
}
async function cleanupUi() {
  let pages=[];try{pages=await targets();}catch{return;}
  const results=await Promise.allSettled(pages.map(page=>evaluate(page,'(() => {window.__codexUsageBadge?.destroy?.();window.__codexProjectColors?.destroy?.({clearStorage:true});window.__codexThreadTokens?.destroy?.();window.__codexProjectSizes?.destroy?.();return !document.getElementById("codex-usage-badge")&&!document.getElementById("codex-project-colors-style")&&!document.getElementById("codex-thread-tokens-style")&&!document.getElementById("codex-project-sizes-style");})()')));
  if(results.some(r=>r.status==='rejected'||r.value!==true))console.warn('部分窗口暂不可连接；后台仍会卸载，残留界面将在下次打开客户端时消失。');
}
async function uninstall(){return operation(uninstallUnlocked);}
async function uninstallUnlocked() {
  await migrateUpdater();
  for(const job of [startupLabel,'com.codexusagebadge.install-once',activationLabel,label])await stop(job);
  await cleanupUi();
  const trash=path.join(home,'.Trash',`CodexUsageBadge-${Date.now()}`);fs.mkdirSync(trash,{recursive:true});
  const paths=[startupPlist,plistPath,...(ownedShortcut()?[desktopLauncher]:[]),...(ownedLauncher()?[launcher]:[]),installDir,...['out.log','err.log','activate.log','activate.err.log','startup.out.log','startup.err.log','updater.out.log','updater.err.log'].map(s=>path.join(logs,`CodexUsageBadge.${s}`))];
  for(const file of paths) {
    try{fs.lstatSync(file);}catch{continue;}
    let dest=path.join(trash,path.basename(file));if(statOrNull(dest))dest+='-shortcut';
    fs.renameSync(file,dest);
  }
  console.log('已卸载并清除界面，无需重启。文件已移入废纸篓。');
}
async function status() {
  console.log('版本：'+VERSION);
  console.log('自动加载：'+(/state = running/.test(loaded(startupLabel)||'')?'运行中':'未运行'));
  console.log('后台：'+(/state = running/.test(loaded(label)||'')?'运行中':'未运行'));
  console.log('自动更新任务：'+(loaded(updaterLabel)?'已注册':'未注册'));
  try{console.log(command(node,[path.join(installDir,'updater/worker.cjs'),'status']));}catch{}
  let pages=[];try{pages=await targets();}catch{}
  console.log('主窗口连接数：'+pages.length);
  for(let i=0;i<pages.length;i++)console.log('窗口 '+(i+1),await evaluate(pages[i],'({usage:window.__codexUsageBadge?.status()??null,projectColors:window.__codexProjectColors?.status()??null,threadTokens:window.__codexThreadTokens?.status()??null,projectSizes:window.__codexProjectSizes?.status()??null})'));
  const receipt=path.join(installDir,'状态.json');if(fs.existsSync(receipt))console.log('上次安装验证记录（历史数据，以以上实时读数为准）：\n'+fs.readFileSync(receipt,'utf8'));
}
module.exports={startupConfig,updaterConfig,agentConfig,activationConfig,waitForExit,xml,install,uninstall,preflight,clientCompatibility,expectedUiVersion,inspectUsageBadge,activate,inspectUpdaterMigration,migrateUpdater};
if(require.main===module)(async()=>{
  const action=process.argv[2];
  if(action==='install')await install({manualTest:process.argv.includes('--manual-test'),allowUnverifiedClient:process.argv.includes('--allow-unverified-client')});
  else if(action==='compatibility'){const result=clientCompatibility();console.log(JSON.stringify(result,null,2));if(result.status!=='VERIFIED')process.exitCode=result.status==='UNSUPPORTED'?1:2;}
  else if(action==='schedule-activation')await scheduleActivation({waitForExit:process.argv.includes('--wait-for-exit')});
  else if(action==='activate'){await pause(3000);await activate({allowRestart:process.argv.includes('--allow-restart')});}
  else if(action==='activate-after-exit')await activateAfterExit();
  else if(action==='launch')await activate({foreground:true});
  else if(action==='uninstall')await uninstall();
  else if(action==='status')await status();
  else if(action==='update-check'||action==='update-enable')rejectAutomaticUpdate();
  else if(action==='update-disable'){disableOwnedUpdates(installDir);console.log('自动更新已关闭');}
  else throw new Error('未知操作：'+action);
})().catch(error=>{
  console.error(error.message);
  if(process.argv[2]?.startsWith('activate')&&!['ERR_UI_STATUS_WRITE','ERR_MANUAL_TEST_CLIENT_CONTROL'].includes(error.code)&&fs.existsSync(installDir)) {
    try { recordActivation({state:'error',message:error.message}); }
    catch(failure) { console.error(failure.message); }
  }
  process.exitCode=1;
});
