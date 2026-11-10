'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const repository='Lorie7813/codex-usage-card';
const intervalMs=6*60*60*1000;
const maxArchive=16*1024*1024,maxExpanded=48*1024*1024;
const required=['agent.cjs','manage.cjs','macos/shortcuts.cjs','macos/startup/bridge','macos/startup/controller.cjs','macos/startup/watch.cjs','updater/core.cjs','updater/worker.cjs','updater/run.sh','update.json'];
// Private builds have no update execution path or runtime opt-in.
function rejectAutomaticUpdate(){
  const error=Error('此私有版永久禁用自动更新；请审阅源码后手动构建和安装');
  error.code='ERR_PRIVATE_UPDATES_DISABLED';throw error;
}
function versionParts(value){
  if(typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))throw Error('无效版本号');
  const parts=value.split('.').map(Number);
  if(parts.some(n=>!Number.isSafeInteger(n)))throw Error('无效版本号');
  return parts;
}
function compareVersions(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;}
function selectRelease(releases,currentVersion,{allowPrerelease=true}={}){
  versionParts(currentVersion);if(!Array.isArray(releases))throw Error('GitHub 返回了无效发布列表');
  let best=null;
  for(const release of releases){
    if(!release||release.draft||!release.published_at||(!allowPrerelease&&release.prerelease)||!Array.isArray(release.assets))continue;
    const match=/^v(\d+\.\d+\.\d+)-macos$/.exec(release.tag_name||'');
    if(!match)continue;
    const version=match[1];
    if(compareVersions(version,currentVersion)<=0)continue;
    const name=`CodexUsageBadge-macOS-${version}.zip`;
    const assets=release.assets.filter(a=>a.name===name&&a.state==='uploaded');
    if(assets.length!==1)continue;
    const asset=assets[0];
    if(!/^sha256:[a-f0-9]{64}$/i.test(asset.digest||'')||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>maxArchive)continue;
    const url=`https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
    if(asset.browser_download_url!==url)continue;
    if(!best||compareVersions(version,best.version)>0)best={version,tag:release.tag_name,url,name,size:asset.size,digest:asset.digest.slice(7).toLowerCase()};
  }
  return best;
}
async function fetchBytes(){rejectAutomaticUpdate();}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let n=0xffffffff;for(const byte of data)n=crcTable[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function safeName(name){
  return name&&name===name.normalize('NFC')&&!/[\\\x00-\x1f\x7f:]/.test(name)&&!name.startsWith('/')&&
    name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.endsWith('.')&&!part.endsWith(' '));
}
function readArchive(buffer,version){
  if(!Buffer.isBuffer(buffer)||buffer.length>maxArchive)throw Error('无效安装包');
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){
    if(buffer.readUInt32LE(i)===0x06054b50&&i+22+buffer.readUInt16LE(i+20)===buffer.length){end=i;break;}
  }
  if(end<0||buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6))throw Error('不支持的 ZIP 格式');
  const count=buffer.readUInt16LE(end+10),centralSize=buffer.readUInt32LE(end+12),start=buffer.readUInt32LE(end+16);
  if(!count||count>128||count!==buffer.readUInt16LE(end+8)||start+centralSize!==end)throw Error('无效 ZIP 索引');
  const prefix=`CodexUsageBadge-macOS-${version}/`,files=new Map(),names=new Set();
  let offset=start,total=0;
  for(let i=0;i<count;i++){
    if(offset+46>end||buffer.readUInt32LE(offset)!==0x02014b50)throw Error('损坏的 ZIP 索引');
    const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),crc=buffer.readUInt32LE(offset+16);
    const compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24);
    const nameSize=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32);
    const mode=buffer.readUInt32LE(offset+38)>>>16,local=buffer.readUInt32LE(offset+42);
    const name=buffer.subarray(offset+46,offset+46+nameSize).toString('utf8');
    offset+=46+nameSize+extra+comment;
    if(offset>end||flags&~0x808||![0,8].includes(method)||((mode&0xf000)!==0&&(mode&0xf000)!==0x8000)||buffer.readUInt16LE(offset-46-nameSize-extra-comment+34)!==0)throw Error('不支持的 ZIP 文件类型');
    if(!name.startsWith(prefix)||!safeName(name.slice(prefix.length)))throw Error('安装包包含不安全路径');
    const relative=name.slice(prefix.length),key=relative.toLowerCase();
    if(names.has(key))throw Error('安装包包含重复文件');names.add(key);
    total+=size;if(total>maxExpanded||size>maxExpanded)throw Error('解压内容超出大小限制');
    if(local+30>start||buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+6)!==flags||buffer.readUInt16LE(local+8)!==method)throw Error('无效 ZIP 文件头');
    const localNameSize=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28);
    if(buffer.subarray(local+30,local+30+localNameSize).toString('utf8')!==name)throw Error('ZIP 路径不一致');
    const dataStart=local+30+localNameSize+localExtra;
    if(dataStart+compressed>start)throw Error('ZIP 文件数据越界');
    const packed=buffer.subarray(dataStart,dataStart+compressed);
    const data=method===8?zlib.inflateRawSync(packed,{maxOutputLength:Math.max(1,size)}):Buffer.from(packed);
    if(data.length!==size||crc32(data)!==crc)throw Error('ZIP 文件损坏');
    files.set(relative,{data,mode:mode&0o777});
  }
  if(offset!==end)throw Error('ZIP 索引长度不一致');
  for(const name of files.keys())for(const other of files.keys())if(other.startsWith(name+'/'))throw Error('ZIP 文件与目录冲突');
  for(const name of required)if(!files.has(name))throw Error('安装包缺少更新组件');
  const manifest=JSON.parse(files.get('update.json').data.toString('utf8'));
  if(manifest.schema!==1||manifest.repository!==repository||manifest.platform!=='macOS'||manifest.version!==version)throw Error('更新包版本或来源不匹配');
  const sums=files.get('SHA256SUMS.txt');if(!sums)throw Error('安装包缺少校验清单');
  const checked=new Set();
  for(const line of sums.data.toString('utf8').trim().split('\n')){
    const m=/^([a-f0-9]{64})  (.+)$/.exec(line);
    if(!m||m[2]==='SHA256SUMS.txt'||checked.has(m[2])||!files.has(m[2]))throw Error('无效校验清单');
    const digest=crypto.createHash('sha256').update(files.get(m[2]).data).digest('hex');
    if(digest!==m[1])throw Error('安装包文件校验失败');checked.add(m[2]);
  }
  if(checked.size!==files.size-1)throw Error('安装包包含未校验文件');
  return files;
}
function extractArchive(){rejectAutomaticUpdate();}
function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp-'+crypto.randomUUID();
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function acquireLock(directory,{pid=process.pid,now=Date.now,isAlive=p=>{try{process.kill(p,0);return true;}catch(e){return e.code!=='ESRCH';}}}={}){
  fs.mkdirSync(path.dirname(directory),{recursive:true,mode:0o700});
  for(let attempt=0;attempt<2;attempt++){
    try{fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify({pid,startedAt:now()}),{mode:0o600,flag:'wx'});return ()=>fs.rmSync(directory,{recursive:true,force:true});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      if(fs.lstatSync(directory).isSymbolicLink())throw Error('更新锁目录不能是链接');
      let owner;try{owner=readJson(path.join(directory,'owner.json'));}catch{}
      const predatesBoot=Number.isFinite(owner?.startedAt)&&owner.startedAt<now()-require('node:os').uptime()*1000-10000;
      if(owner&&Number.isSafeInteger(owner.pid)&&owner.pid>0){if(!predatesBoot&&isAlive(owner.pid))return null;}
      else if(now()-fs.statSync(directory).mtimeMs<120000)return null;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  }
  return null;
}
async function updateOnce(){rejectAutomaticUpdate();}
function ownedSnapshot(file,{root=require('node:os').homedir(),kind='file',allowMissing=false}={}){
  const invalid=()=>{const error=Error('无法验证更新路径归属：'+file);error.code='ERR_UPDATE_PATH_OWNERSHIP';throw error;};
  const fields=['dev','ino','uid','mode','size','mtimeMs','ctimeMs','nlink'];
  const identity=stat=>Object.freeze(Object.fromEntries(fields.map(field=>[field,stat[field]])));
  const same=(actual,expected,metadata=true)=>fields.every(field=>!metadata&&['size','mtimeMs','ctimeMs','nlink'].includes(field)||actual[field]===expected[field]);
  try{
    if(typeof root!=='string'||typeof file!=='string'||!['file','directory'].includes(kind)||!path.isAbsolute(root)||!path.isAbsolute(file)||path.resolve(root)!==root||path.resolve(file)!==file)invalid();
    const uid=process.getuid?.();
    if(!Number.isInteger(uid)||!(file===root||file.startsWith(root+path.sep)))invalid();
    const directories=[];
    const validDirectory=stat=>!stat.isSymbolicLink()&&stat.isDirectory()&&stat.uid===uid&&(stat.mode&0o022)===0;
    const validLeaf=stat=>!stat.isSymbolicLink()&&(kind==='directory'?stat.isDirectory():stat.isFile()&&stat.nlink===1)&&stat.uid===uid&&(stat.mode&0o022)===0;
    const rootStat=fs.lstatSync(root);
    if(!validDirectory(rootStat)||fs.realpathSync(root)!==root)invalid();
    directories.push({file:root,stat:identity(rootStat)});
    const segments=path.relative(root,file).split(path.sep).filter(Boolean);
    let current=root,leaf,missing;
    if(!segments.length){if(kind!=='directory')invalid();leaf=rootStat;}
    for(let index=0;index<segments.length;index++){
      current=path.join(current,segments[index]);
      let stat;
      try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT'||!allowMissing)invalid();missing=current;break;}
      if(index===segments.length-1){if(!validLeaf(stat))invalid();leaf=stat;}
      else{if(!validDirectory(stat)||fs.realpathSync(current)!==current)invalid();directories.push({file:current,stat:identity(stat)});}
    }
    if(leaf&&kind==='file'&&(!Number.isSafeInteger(leaf.size)||leaf.size<0||leaf.size>8*1024*1024))invalid();
    const stat=leaf?identity(leaf):null;
    function verify(){
      try{
        for(const entry of directories){const now=fs.lstatSync(entry.file);if(!validDirectory(now)||!same(now,entry.stat,false)||fs.realpathSync(entry.file)!==entry.file)invalid();}
        if(missing){
          try{fs.lstatSync(missing);}catch(error){if(error.code==='ENOENT')return true;throw error;}
          invalid();
        }
        const now=fs.lstatSync(file);
        if(!validLeaf(now)||!same(now,stat,kind==='file'))invalid();
        return true;
      }catch{invalid();}
    }
    function read(){
      try{
        if(!stat||kind!=='file')invalid();
        verify();
        let descriptor;
        try{
          descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
          const opened=fs.fstatSync(descriptor);
          if(!validLeaf(opened)||!same(opened,stat))invalid();
          const buffer=Buffer.alloc(stat.size+1);let length=0;
          while(length<buffer.length){const count=fs.readSync(descriptor,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
          if(length!==stat.size||!same(fs.fstatSync(descriptor),stat))invalid();
          verify();return buffer.subarray(0,length);
        }finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
      }catch{invalid();}
    }
    const snapshot=Object.freeze({exists:!!leaf,stat,read,verify});
    verify();return snapshot;
  }catch{invalid();}
}
const ownedSettingsTokens=new WeakMap();
function invalidUpdateSettings(){
  const error=Error('无法验证本插件的自动更新配置归属，未修改设置');
  error.code='ERR_UPDATE_SETTINGS_OWNERSHIP';throw error;
}
function inspectOwnedUpdates(installDir,{allowMissing=false}={}){
  try{
    if(typeof installDir!=='string'||!path.isAbsolute(installDir)||path.resolve(installDir)!==installDir)invalidUpdateSettings();
    const snapshot=ownedSnapshot(path.join(installDir,'update-settings.json'),{allowMissing});
    const settings=snapshot.exists?JSON.parse(snapshot.read().toString('utf8')):null;
    if(snapshot.exists&&(!settings||typeof settings!=='object'||Array.isArray(settings)||settings.owner!=='codex-usage-badge-updater-v1'))invalidUpdateSettings();
    const verify=()=>{try{return snapshot.verify();}catch{invalidUpdateSettings();}};
    const token=Object.freeze({exists:snapshot.exists,enabled:snapshot.exists?settings.enabled!==false:null,verify});
    ownedSettingsTokens.set(token,{installDir,snapshot,settings});return token;
  }catch{invalidUpdateSettings();}
}
function disableOwnedUpdates(installDir,{expected}={}){
  let tempDescriptor,temp,tempStat;
  try{
    const token=expected===undefined?inspectOwnedUpdates(installDir):expected;
    const owned=ownedSettingsTokens.get(token);
    if(!owned||owned.installDir!==installDir||!owned.snapshot.exists)invalidUpdateSettings();
    const {snapshot,settings}=owned;
    snapshot.verify();
    if(settings.enabled===false)return false;
    const file=path.join(installDir,'update-settings.json'),candidate=file+'.tmp-'+crypto.randomUUID();
    tempDescriptor=fs.openSync(candidate,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    temp=candidate;tempStat=fs.fstatSync(tempDescriptor);
    if(!tempStat.isFile()||tempStat.uid!==snapshot.stat.uid||(tempStat.mode&0o022)!==0||tempStat.nlink!==1)invalidUpdateSettings();
    fs.writeFileSync(tempDescriptor,JSON.stringify({...settings,enabled:false},null,2)+'\n');
    snapshot.verify();
    const written=fs.fstatSync(tempDescriptor),pending=fs.lstatSync(temp);
    if(pending.isSymbolicLink()||!pending.isFile()||pending.uid!==snapshot.stat.uid||(pending.mode&0o022)!==0||pending.nlink!==1||
      ['dev','ino','uid','mode','size','mtimeMs','ctimeMs','nlink'].some(field=>pending[field]!==written[field])||pending.dev!==tempStat.dev||pending.ino!==tempStat.ino)invalidUpdateSettings();
    fs.renameSync(temp,file);temp=undefined;
    return true;
  }catch{invalidUpdateSettings();}
  finally{
    if(temp&&tempStat){
      try{const pending=fs.lstatSync(temp);if(!pending.isSymbolicLink()&&pending.isFile()&&pending.uid===tempStat.uid&&pending.dev===tempStat.dev&&pending.ino===tempStat.ino)fs.unlinkSync(temp);}catch{}
    }
    if(tempDescriptor!==undefined){try{fs.closeSync(tempDescriptor);}catch{invalidUpdateSettings();}}
  }
}
module.exports={rejectAutomaticUpdate,ownedSnapshot,inspectOwnedUpdates,disableOwnedUpdates,repository,intervalMs,versionParts,compareVersions,selectRelease,fetchBytes,readArchive,extractArchive,writeJson,readJson,acquireLock,updateOnce};
