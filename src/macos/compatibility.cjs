'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const MATCH_FIELDS=['appName','bundleIdentifier','appVersion','appBuild','executableName','executableRelativePath','cliRelativePath','cliVersion'];
const APP_NAMES=new Set(['Codex.app','ChatGPT.app']);
function unsupported(reason){return {status:'UNSUPPORTED',reason,client:null};}
function safeField(value,pattern){return typeof value==='string'&&value.length<=160&&pattern.test(value);}
function validClient(client){
  return client&&typeof client==='object'&&!Array.isArray(client)&&
    safeField(client.appName,/^(?:Codex\.app|ChatGPT\.app|Selected macOS app)$/)&&
    safeField(client.bundleIdentifier,/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/)&&
    safeField(client.appVersion,/^[0-9][A-Za-z0-9._+-]{0,79}$/)&&
    safeField(client.appBuild,/^[0-9][A-Za-z0-9._+-]{0,79}$/)&&
    safeField(client.executableName,/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/)&&
    client.executableRelativePath==='Contents/MacOS/'+client.executableName&&
    (client.cliRelativePath==='external executable'||safeField(client.cliRelativePath,/^Contents\/(?:[A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+$/)&&!client.cliRelativePath.split('/').some(x=>x==='.'||x==='..'))&&
    safeField(client.cliVersion,/^codex-cli [0-9][A-Za-z0-9._+-]{0,119}$/);
}
function validRegistry(registry){
  return registry&&registry.schema===1&&Array.isArray(registry.verified)&&Array.isArray(registry.unsupported)&&
    registry.verified.every(row=>validClient(row?.client))&&registry.unsupported.every(row=>validClient(row?.client));
}
function classifyCompatibility(client,registry){
  if(!validClient(client))return unsupported('Client version metadata is missing or cannot be interpreted.');
  if(!validRegistry(registry))return unsupported('The compatibility record is missing or invalid.');
  const matches=row=>MATCH_FIELDS.every(key=>row.client[key]===client[key]);
  if(registry.unsupported.some(matches))return {status:'UNSUPPORTED',reason:'This exact client and CLI combination is documented as incompatible.',client};
  if(registry.verified.some(matches))return {status:'VERIFIED',reason:'This exact client and CLI combination passed the recorded v0.9.4 Mac acceptance; v0.9.5 still requires separate real installation acceptance.',client};
  return {status:'UNVERIFIED',reason:'This valid client and CLI combination has not been tested. No compatible version range is assumed.',client};
}
function inspectCompatibility({app,cli,fileSystem=fs,exec=execFileSync,registry,nodeVersion=process.versions.node}={}){
  if(typeof nodeVersion!=='string'||!/^\d+(?:\.\d+){1,2}(?:[-+][A-Za-z0-9.-]+)?$/.test(nodeVersion)||Number(nodeVersion.split('.')[0])<24)return unsupported('Node.js 24 or newer is required.');
  try{
    if(typeof app!=='string'||!path.isAbsolute(app)||typeof cli!=='string'||!path.isAbsolute(cli))return unsupported('The selected application or CLI is unavailable.');
    const info=path.join(app,'Contents/Info.plist');
    if(!fileSystem.statSync(app).isDirectory()||!fileSystem.statSync(info).isFile())return unsupported('The application bundle metadata is unavailable.');
    const read=field=>String(exec('/usr/libexec/PlistBuddy',['-c','Print :'+field,info],{encoding:'utf8',timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe']})).trim();
    const bundleIdentifier=read('CFBundleIdentifier'),appVersion=read('CFBundleShortVersionString'),appBuild=read('CFBundleVersion'),executableName=read('CFBundleExecutable');
    if(!safeField(executableName,/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/))return unsupported('The application executable metadata is invalid.');
    const executableRelativePath='Contents/MacOS/'+executableName,executable=path.join(app,executableRelativePath);
    for(const file of [executable,cli]){fileSystem.accessSync(file,fileSystem.constants.X_OK);if(!fileSystem.statSync(file).isFile())return unsupported('A required executable is unavailable.');}
    const cliVersion=String(exec(cli,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe']})).trim();
    const relative=path.relative(app,cli),cliRelativePath=relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)?relative.split(path.sep).join('/'):'external executable';
    const basename=path.basename(app),client={appName:APP_NAMES.has(basename)?basename:'Selected macOS app',bundleIdentifier,appVersion,appBuild,executableName,executableRelativePath,cliRelativePath,cliVersion};
    if(registry===undefined)registry=JSON.parse(fileSystem.readFileSync(path.join(__dirname,'compatibility.json'),'utf8'));
    return classifyCompatibility(client,registry);
  }catch{return unsupported('Required application metadata or the Codex CLI version could not be read safely.');}
}
function compatibilityError(result,code='ERR_CLIENT_UNSUPPORTED'){
  const error=new Error(result.status+': '+result.reason);error.code=code;return error;
}
async function confirmCompatibility(result,{allowUnverifiedClient=false,interactive=false,ask,warn=()=>{}}={}){
  if(result.status==='UNSUPPORTED')throw compatibilityError(result);
  if(result.status==='VERIFIED')return;
  if(result.status!=='UNVERIFIED')throw compatibilityError(unsupported('The compatibility result is invalid.'));
  warn('UNVERIFIED: '+result.reason);
  if(allowUnverifiedClient===true)return;
  if(!interactive||typeof ask!=='function')throw compatibilityError(result,'ERR_CLIENT_UNVERIFIED');
  let response;
  try{response=await ask('Continue with this untested client version? [y/N] ');}catch{throw compatibilityError(result,'ERR_CLIENT_UNVERIFIED');}
  if(typeof response!=='string'||!/^(?:y|yes)$/i.test(response.trim()))throw compatibilityError(result,'ERR_CLIENT_CONFIRMATION_DECLINED');
}
module.exports={inspectCompatibility,classifyCompatibility,confirmCompatibility};
