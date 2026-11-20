"""Run a local packaged-host fixture test; no real model API or personal profile."""
import argparse,json,os,pathlib,subprocess,sys,datetime,shutil
parser=argparse.ArgumentParser()
parser.add_argument('--desktop',required=True,help='Installed Harness executable (RUN_AS_NODE fuse must be enabled)')
parser.add_argument('--host-node-modules',help='Freshly extracted node_modules for the exact installed host')
parser.add_argument('--node',default='node');parser.add_argument('--full',action='store_true')
args=parser.parse_args();root=pathlib.Path(__file__).resolve().parent.parent
exe=pathlib.Path(args.desktop).resolve();assert exe.is_file()
wire=exe.read_bytes();sentinel=wire.find(b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
assert sentinel>=0 and wire[sentinel+34]==ord('1'),'RUN_AS_NODE fuse unavailable; refuse to launch an interactive app'
output=root/'.local'/('check-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
output.mkdir(parents=True,exist_ok=False)
env=dict(os.environ)
for name in list(env):
 if name.upper() in ['NODE_OPTIONS','NODE_PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NODE_USE_ENV_PROXY','TYPESAFE_API_KEY','DEEPSEEK_API_KEY','OPENROUTER_API_KEY','GH_TOKEN','GITHUB_TOKEN']:
  env.pop(name)
env.update(ELECTRON_RUN_AS_NODE='1',DSH_HOME=str(output/'home'),DSH_TELEMETRY_DISABLED='1')
process=subprocess.run([str(exe),str(root/'tools/desktop-smoke.mjs'),str(exe),str(output)],cwd=root,env=env,
 capture_output=True,text=True,encoding='utf-8',timeout=65,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
(output/'desktop.log').write_text(process.stdout+'\n'+process.stderr,encoding='utf-8')
report=output/'desktop-result.json'
if report.exists():print(report.read_text(encoding='utf-8'))
assert process.returncode==0 and report.exists() and json.loads(report.read_text(encoding='utf-8'))['passed'],'See '+str(output/'desktop.log')
if args.full:
 assert args.host_node_modules,'--full requires --host-node-modules from the current ASAR extraction'
 native=pathlib.Path(args.host_node_modules).resolve();assert native.is_dir()
 node=shutil.which(args.node) or args.node
 env['PATH']=str(pathlib.Path(node).resolve().parent)+os.pathsep+env.get('PATH','')
 env.pop('ELECTRON_RUN_AS_NODE',None)
 env.update(DSH_HOST_NODE_MODULES=str(native),DSH_HOST_NATIVE_NODE_MODULES=str(native),DSH_YAML_PATH=str(native/'yaml/dist/index.js'))
 with (output/'tests.log').open('w',encoding='utf-8') as stream:
  tests=subprocess.run([node,'--run','test'],cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=180)
 assert tests.returncode==0,'Full suite failed: '+str(output/'tests.log')
 print('Full local suite passed: '+str(output/'tests.log'))
print('Evidence: '+str(output))
