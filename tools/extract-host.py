"""Extract only packaged host code/native assets to ignored .local storage."""
import argparse,hashlib,json,pathlib,shutil,struct
parser=argparse.ArgumentParser();parser.add_argument('--desktop',required=True);args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parent.parent
asar=pathlib.Path(args.desktop).resolve().parent/'resources/app.asar'
digest=hashlib.sha256(asar.read_bytes()).hexdigest()
out=root/'.local/hosts'/digest[:12]
if (out/'host.json').exists():
 print((out/'host.json').read_text(encoding='utf-8'));raise SystemExit(0)
out.mkdir(parents=True,exist_ok=False);target=out/'host';target.mkdir();links=[];count=[0]
with asar.open('rb') as stream:
 h=struct.unpack('<IIII',stream.read(16));tree=json.loads(stream.read(h[3]));base=8+h[1]
 def walk(node,parts):
  dest=target.joinpath(*parts);assert dest.resolve().is_relative_to(target.resolve())
  if 'files' in node:
   dest.mkdir(parents=True,exist_ok=True)
   for name,child in node['files'].items():walk(child,[*parts,name])
  elif 'link' in node:links.append((parts,node['link']))
  elif node.get('unpacked'):
   shutil.copyfile(asar.with_name('app.asar.unpacked').joinpath(*parts),dest);count[0]+=1
  else:
   stream.seek(base+int(node['offset']));dest.write_bytes(stream.read(node['size']));count[0]+=1
 for name in ['dsh','lib','package.json']:walk(tree['files'][name],[name])
for parts,name in links:
 src=target/name;dest=target.joinpath(*parts);assert src.resolve().is_relative_to(target.resolve())
 if src.is_dir():shutil.copytree(src,dest,dirs_exist_ok=True)
 else:shutil.copyfile(src,dest)
meta=json.loads((target/'package.json').read_text(encoding='utf-8'))
report={'hostVersion':meta['version'],'buildCommit':meta.get('dshBuildCommit'),'asarSha256':digest,'files':count[0],
 'hostNodeModules':str(target/'dsh/node_modules')}
(out/'host.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
