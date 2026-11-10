'use strict';
const path=require('node:path'),os=require('node:os');
const {rejectAutomaticUpdate,disableOwnedUpdates,readJson}=require('./core.cjs');
const installDir=path.resolve(__dirname,'..');
const cacheDir=path.join(os.homedir(),'Library/Caches/CodexUsageBadge-updates');
async function main(args=process.argv.slice(2)){
  const mode=args[0]||'run';
  if(['enable','check','run'].includes(mode))rejectAutomaticUpdate();
  if(args.length!==1||!['status','disable'].includes(mode))throw Error('未知更新操作');
  if(process.platform!=='darwin')throw Error('此更新器仅供 macOS 使用');
  if(mode==='disable'){
    disableOwnedUpdates(installDir);console.log('自动更新已关闭');return;
  }
  console.log(JSON.stringify({settings:readJson(path.join(installDir,'update-settings.json')),status:readJson(path.join(cacheDir,'state.json'))},null,2));
}
module.exports={main};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
