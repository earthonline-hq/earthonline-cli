// Optional Windows ConPTY smoke, adapted from the prior codex-push-exp/exp3.js fixture.
// EOL_PTY_MODULE points to an existing node-pty installation; no downloads or shell execution.
import { fixtureRuntime } from './codex-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require(process.env.EOL_PTY_MODULE || 'node-pty');

const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'et-'));
const eol = path.join(root, 'eol'); fs.mkdirSync(eol);
const origin = `http://127.0.0.1:${PORT_BASE + 11}`;
const launcher = path.join(fixtureRuntime(root, eol, origin), 'codex.mjs');
fs.writeFileSync(path.join(eol, 'key'), 'eolc_' + 'a'.repeat(40));
fs.writeFileSync(path.join(root, 'config.toml'), `model="mock-model"\nmodel_provider="mock"\napproval_policy="on-request"\nsandbox_mode="read-only"\n[model_providers.mock]\nname="mock"\nbase_url="http://127.0.0.1:${PORT_BASE + 11}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n[tui]\nscreen_reader_detection_done=true\n`);
const env = {...process.env, CODEX_HOME: root, EOL_HOME:eol, EOL_ORIGIN:origin, TERM:'xterm-256color'};
let n=0, terminal, watchdog, notifyModel=()=>{};
const model=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  if(!req.url.includes('responses')){res.setHeader('content-type','application/json');res.end('{"ok":true,"result":{"tools":[]},"models":[]}');return;}
  n++;const id='resp_'+n, mid='msg_'+n;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const ev=(type,o)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...o})+'\n\n');
  ev('response.created',{response:{id}});
  const item={type:'message',role:'assistant',id:mid,content:[{type:'output_text',text:'TUI_FIXTURE_OK'}]};
  ev('response.output_item.added',{output_index:0,item:{...item,content:[]}});
  ev('response.output_text.delta',{item_id:mid,output_index:0,content_index:0,delta:'TUI_FIXTURE_OK'});
  ev('response.output_item.done',{output_index:0,item});ev('response.completed',{response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();notifyModel();
});
await new Promise(r=>model.listen(PORT_BASE + 11,'127.0.0.1',r));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function run(force){
  terminal=pty.spawn(process.execPath,[launcher,'--port',String(PORT_BASE + 12)],{name:'xterm-256color',cols:120,rows:36,cwd:root,env});
  let text='',sent=false,quit=false;
  let ready,done;
  const readyP=new Promise(r=>ready=r), doneP=new Promise(r=>done=r);notifyModel=()=>setTimeout(ready,300);
  terminal.onExit(e=>done(e));
  const timer=watchdog=setTimeout(()=>{console.error('TUI requests:',n,'tail:',text.slice(-1600));process.kill(terminal.pid);},30000);
  terminal.onData(data=>{
    text=(text+data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/\x1b\][^\x07]*\x07/g,'')).slice(-12000);
    if(!sent && (text.includes('mock-model') || text.includes('›'))){sent=true;setTimeout(()=>{terminal.write('TUI-SEED');setTimeout(()=>terminal.write('\r'),300);},1000);}
    if(text.includes('TUI_FIXTURE_OK')&&!quit){quit=true;ready();}
  });
  await Promise.race([readyP,doneP.then(e=>{throw new Error('TUI exited before fake-model response: '+e.exitCode+'; tail: '+text.slice(-1600));})]);
  assert.ok(n>0,'real remote TUI reached fake model');
  const recordPath=path.join(eol,'live',`wrapper-codex-${terminal.pid}.pid`);
  const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  assert.ok(record.supervisor&&record.serverPid&&record.tuiPid);
  const socket=net.connect(PORT_BASE + 12,'127.0.0.1');await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});
  const serverClosed=new Promise(r=>{socket.on('error',()=>{});socket.once('close',r);});
  socket.resume();
  const began=Date.now();
  if(force)process.kill(terminal.pid);else { await new Promise(r=>setTimeout(r,1000)); terminal.write('/quit'); await new Promise(r=>setTimeout(r,400)); terminal.write('\r'); }
  await Promise.race([serverClosed,new Promise((_,j)=>setTimeout(()=>j(new Error('owned server did not close; tail: '+text.slice(-1600))),6000))]);
  await doneP;clearTimeout(timer);
  // The transport closure precedes supervisor's final filesystem cleanup by a few instructions.
  await new Promise(r=>setTimeout(r,250));
  assert.equal(alive(record.tuiPid),false,'owned TUI exited');
  assert.equal(alive(record.serverPid),false,'owned app-server exited');
  assert.equal(alive(record.supervisor),false,'owned supervisor exited');
  assert.equal(fs.readdirSync(path.join(eol,'live')).filter(x=>x.startsWith('codex-auth-')).length,0,'token directory cleaned');
  assert.equal(fs.existsSync(recordPath),false, "wrapper record cleaned even on forced exit");
  console.log(`PASS real remote TUI ${force?'forced wrapper death':'normal /quit'} cleanup in ${Date.now()-began}ms`);
}
try{await run(process.argv.includes('--force'));}catch(e){ console.error(fs.existsSync(path.join(eol,'live.log'))?fs.readFileSync(path.join(eol,'live.log'),'utf8'):'No launcher log'); throw e; }finally{
  clearTimeout(watchdog);
  try{if(terminal&&alive(terminal.pid))process.kill(terminal.pid);}catch{}
  model.closeAllConnections();await new Promise(r=>model.close(r));
  try{fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}catch{console.log('Windows fixture cleanup deferred:',root);}
}

// node-pty's Windows helper may retain its native pipe after the asserted PTY exit.
process.exit(0);
