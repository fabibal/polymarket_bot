// Run on the host: node --test tests/release_watch_wrapper.check.cjs
// All docker/curl calls are local fixtures. No Telegram or live containers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const wrapper = path.resolve('scripts/release-watch.sh');
function setup(mode) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-watch-wrapper-'));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'docker'),`#!/usr/bin/env python3
import sys,os,json,time,pathlib
a=sys.argv[1:]
mode=os.environ.get('FIXTURE_MODE','ok')
if a[0]=='ps':
 print('gluetun' if mode!='vpn_down' else ''); sys.exit(0)
if a[0]=='rm': sys.exit(0)
if a[0]!='run': sys.exit(9)
env={a[i+1].split('=',1)[0]:a[i+1].split('=',1)[1] for i,x in enumerate(a) if x=='-e'}
id,part=a[-2:];run=env['RW_RUN_ID']
out=pathlib.Path(os.environ['RW_PROJECT_DIR'])/'logs'/'release-watch'/id/run
if mode=='block': time.sleep(1.5)
if mode=='child_failure' and part=='book': print('TG book FAILED');sys.exit(7)
s={'schemaVersion':2,'release':id,'runId':run,'quality':{'ok':mode!='bad_quality'}}
(out/(part+'_summary.json')).write_text(json.dumps(s))
print('TG '+part+' fixture')
`);
  fs.writeFileSync(path.join(bin,'curl'),`#!/usr/bin/env python3
import sys,os,pathlib
if any('api.telegram.org' in a for a in sys.argv):
 pathlib.Path(os.environ['RW_PROJECT_DIR'],'telegram_attempt').touch()
 sys.exit(22 if os.environ.get('FIXTURE_MODE')=='telegram_failure' else 0)
print('{"status": "ok"}')
`);
  for(const name of ['docker','curl'])fs.chmodSync(path.join(bin,name),0o755);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,RW_PROJECT_DIR:dir,RW_NOTIFY:'0',RELEASE_WATCH_FORCE:'1',FIXTURE_MODE:mode,SHARED_ENV:path.join(dir,'absent')};
  return {dir,env,id:'test-2026-10-21'};
}
function run(f) {return spawnSync('bash',[wrapper,f.id],{env:f.env,encoding:'utf8',timeout:15000});}
function log(f){return fs.readFileSync(path.join(f.dir,'logs/release-watch.log'),'utf8');}
for(const mode of ['child_failure','bad_quality','vpn_down'])test(mode+' is a failed run, never exit 0',()=>{
 const f=setup(mode);try{const r=run(f);assert.equal(r.status,1,r.stderr);assert.match(log(f),/FAIL/);assert.ok(!fs.existsSync(path.join(f.dir,'telegram_attempt')));}finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('repeated runs preserve distinct directories and move latest',()=>{
 const f=setup('ok');try{
  assert.equal(run(f).status,0);assert.equal(run(f).status,0);
  const root=path.join(f.dir,'logs/release-watch',f.id), dirs=fs.readdirSync(root).filter(n=>fs.statSync(path.join(root,n)).isDirectory());
  assert.equal(dirs.length,2);assert.ok(dirs.includes(fs.readFileSync(path.join(root,'latest'),'utf8').trim()));
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('Telegram failure does not destroy a successful measurement',()=>{
 const f=setup('telegram_failure');
 f.env.RW_NOTIFY='1';fs.writeFileSync(f.env.SHARED_ENV,'TELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_CHAT_ID=fixture\nPOLYMARKET_TELEGRAM_CHAT_ID=fixture\n');
 try{assert.equal(run(f).status,0);assert.match(log(f),/telegram_send_failed/);assert.match(log(f),/\| OK \|/);}finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('overlapping invocation cannot touch the active run',async()=>{
 const f=setup('block');
 try{
  const child=spawn('bash',[wrapper,f.id],{env:f.env,stdio:'ignore'});
  const done=new Promise(resolve=>child.on('close',resolve));
  // Wait for the lock/start marker, not an arbitrary multi-second sleep.
  for(let i=0;i<100&&!fs.existsSync(path.join(f.dir,'logs/release-watch',f.id,'latest'));i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(run(f).status,75);assert.equal(await done,0);assert.match(log(f),/already running/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
