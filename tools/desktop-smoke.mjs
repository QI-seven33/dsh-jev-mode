// Packaged Electron test. Default loader, real ASAR, no external model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,readFile,writeFile,symlink } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const [exe,output]=process.argv.slice(2);
assert.ok(exe&&output,'Pass Desktop executable and isolated output directory');
const anchor=path.join(path.dirname(exe),'resources/app.asar/dsh/package.json');
const hostRequire=createRequire(anchor),mod=name=>import(pathToFileURL(hostRequire.resolve('@deepseek-ai/'+name)));
const pkg=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
const home=path.join(output,'home'),dir=path.join(home,'profiles/desktop');
const report={pluginVersion:pkg.version,electron:process.versions.electron,node:process.versions.node,
  actualPackagedAsar:true,loadProxyOverride:false,realModelCalls:0,personalSettingsModified:false};
let ctx,network;
const seen=[],sockets=new Set();
const proxy=http.createServer((req,res)=>{
 let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
  const parsed=JSON.parse(body);seen.push({method:req.method,url:req.url,syntheticAuth:req.headers.authorization==='Bearer synthetic',model:parsed.model});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({answers:{authorize:{type:'noul',noul:.06}}}));
 });
});
proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
try{
 assert.ok(process.versions.electron,'Run using the installed Electron executable in Node mode');
 const [{boot,loadProfileDirectory,createRuntimeResolution,PluginPackages,evaluatePluginCompatibility,getDshRuntimeVersion},
  {provideCmdline},{createLaunchEnvironmentSnapshot},{SessionId},{createHttpNetwork,readWindowsProxy},{createHttpEngine},{executeNativeTool}]=await Promise.all([
  mod('dsh-app-boot'),mod('dsh-cmdline'),mod('dsh-launch-environment'),mod('dsh-session'),
  import(pathToFileURL(path.join(project,'lib/http-network.js'))),import(pathToFileURL(path.join(project,'lib/engine.js'))),
  import(pathToFileURL(path.join(project,'lib/native-tools.js')))]);
 report.hostVersion=getDshRuntimeVersion();report.compatibilityIssue=evaluatePluginCompatibility(pkg)??null;
 assert.equal(report.compatibilityIssue,null,'Declared host compatibility failed; never bypass it with an exemption');
 await mkdir(path.join(dir,'node_modules'),{recursive:true});
 await symlink(project,path.join(dir,'node_modules/dsh-jev-mode'),'junction');
 await writeFile(path.join(dir,'package.json'),JSON.stringify({name:'isolated-desktop-check',private:true,type:'module',
  dependencies:{'dsh-jev-mode':'link:'+project},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-jev-mode']}}}));
 await writeFile(path.join(dir,'cordis.patch.yml'),'[]\n');report.externalPluginJunction=true;
 report.systemProxyDetected=!!(await readWindowsProxy());
 const environment=createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env,
  HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,HTTPS_PROXY:`http://127.0.0.1:${proxy.address().port}`,NO_PROXY:'localhost,127.0.0.1,::1'}}]);
 network=createHttpNetwork({hostContext:{get:name=>name==='profileContext'?{installAnchor:anchor}:undefined},environment});
 const engine=createHttpEngine({id:'typesafe',model:'jev-1.13.0',endpoint:'http://jev-fixture.invalid/v1/systemone',
  resolveKey:()=> 'synthetic',retries:0,fetchFn:network.fetch});
 assert.equal((await engine.ask({channel:'authorize',state:'Synthetic; execute nothing',signal:AbortSignal.timeout(3000)})).answers.authorize.noul,.06);
 report.defaultLoaderBeforeHooks=true;await network.dispose();network=undefined;
 const profile=loadProfileDirectory('dsh',dir,anchor,{userLayer:false});assert.deepEqual(profile.skippedBundles,[]);
 const resolution=await createRuntimeResolution({installAnchor:anchor,home,profile});
 const patches=structuredClone(profile.layers.flatMap(layer=>layer.patches));
 const row=patches.flatMap(p=>p.insert??[]).find(row=>row.id==='preset-jev');
 const jev=row.config.plugins.find(row=>row.name==='dsh-jev-mode/mode');
 jev.config={...jev.config,backend:'typesafe',ledgerEnabled:false,typesafe:{model:'jev-1.13.0',apiKey:'synthetic',endpoint:'http://jev-fixture.invalid/v1/systemone'}};
 patches.push({id:'session-telemetry-otel',disabled:true},{id:'desktop-product-telemetry',disabled:true},
  {id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},{id:'web-runtime',config:{openBrowser:false,printUrl:false}});
 const port=await new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const config=path.join(dir,'isolated-root.yml');await writeFile(config,'[]\n');
 ctx=await boot('dsh',config,patches,async c=>{
  c.provide('profileContext',{name:'desktop',dir,home,cwd:project,patchPath:path.join(dir,'cordis.patch.yml'),installAnchor:anchor,
   overlays:[],telemetryDisabledEnv:'1',startedBundles:profile.layers.map(layer=>layer.packageName)});
  c.provide('launchEnvironment',environment);await c.plugin(PluginPackages,{resolution});
  provideCmdline(c,{args:['--no-open','--port',String(port)],exit:code=>{throw Error('Unexpected exit '+code);}});
 });
 const presets=await ctx.agentPresets.list();for(const id of ['standard','jev']){const p=presets.find(p=>p.id===id);assert.ok(p);assert.equal(p.broken,undefined);}
 const create=id=>ctx.agents.create({sessionId:SessionId('compat-'+id+'-'+Date.now()),agentOptions:{provider:'fixture',model:'fixture'},
  meta:{cwd:project},setup:async c=>{await ctx.agentPresets.mount(c,id);}});
 const standard=await create('standard'),agent=(await create('jev')).agent;
 const native=ctx.tools.schemas(standard.agent),all=ctx.tools.schemas(agent),extra=new Set(['jev_decide','jev_gate','jev_status']);
 const order=rows=>[...rows].sort((a,b)=>a.name.localeCompare(b.name));assert.deepEqual(order(all.filter(row=>!extra.has(row.name))),order(native));
 report.standardTools=native.length;report.jevTools=all.length;report.nativeSchemasEqual=true;
 const call=(name,args)=>executeNativeTool(ctx.tools,{agent,name,arguments:args,callId:'check-'+name,signal:AbortSignal.timeout(5000)});
 const status=await call('jev_status',{});assert.equal(status.isError,false);assert.equal(status.value.version,pkg.version);
 const decision=await call('jev_decide',{channel:'authorize',state:'Synthetic: inspect only, publication forbidden. Execute no commands.'});
 assert.equal(decision.isError,false);assert.equal(decision.value.verdict,'deny');assert.equal(decision.value.probability,.06);
 const read=await call('read',{file_path:path.join(project,'package.json'),offset:1,limit:8});assert.equal(read.isError,false);
 assert.match(JSON.stringify(read),/dsh-jev-mode/);report.nativeReadSucceeded=true;
 assert.equal(seen.length,2);assert.ok(seen.every(row=>row.method==='POST'&&row.url==='http://jev-fixture.invalid/v1/systemone'&&row.syntheticAuth&&row.model==='jev-1.13.0'));
 report.nativeStatus=status.value.version;report.nativeDecision='deny';report.localFixtureHttpRequests=seen.length;report.passed=true;
}catch(error){report.passed=false;report.error={name:error.name,message:error.message};console.error(error.stack);process.exitCode=1;}
finally{
 await network?.dispose();await ctx?.fiber.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));
 await writeFile(path.join(output,'desktop-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
