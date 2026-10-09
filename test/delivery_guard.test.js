import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import register from '../http/workflow.js';
function fixture(agent='coder',request=async()=>({ok:true})) {
 const dir=mkdtempSync(join(tmpdir(),'wf-guard-')); mkdirSync(join(dir,'workflows'));
 const path=join(dir,'workflows','wf_guard.json');
 writeFileSync(path,JSON.stringify({id:'wf_guard',title:'Guard',sessionId:'mock',nodes:[{id:'a',title:'A',defaultAgent:agent,dependsOn:[]}]}));
 let handler; register({get(){},post(p,h){handler=h;}},{dataDir:dir,bus:{request}});
 const call=()=>handler({req:{param:()=> 'wf_guard',json:async()=>({})},json:(data,status=200)=>({data,status})});
 return {dir,path,call};
}
test('generic transport exception locks delivery and prevents replay',async()=>{
 let calls=0; const f=fixture('coder',async()=>{calls++;throw Error('socket closed');});
 try {assert.equal((await f.call()).status,504);assert.equal(JSON.parse(readFileSync(f.path)).status,'delivery_unknown');assert.equal((await f.call()).status,423);assert.equal(calls,1);} finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('omitted assignments cannot bypass unknown stored agent validation',async()=>{
 let calls=0;const f=fixture('nonexistent',async()=>{calls++;return {ok:true};});
 try {assert.equal((await f.call()).status,400);assert.equal(calls,0);} finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('UI uncertain replies and transport catch freeze submission',()=>{
 const source=readFileSync(new URL('../lib/theme.js',import.meta.url),'utf8');
 assert.match(source,/\[409,423,504\]/);assert.match(source,/if \(locked\) ALREADY_DONE = true/);
 assert.match(source,/\.catch\(function\(err\) \{[\s\S]*?ALREADY_DONE = true;[\s\S]*?btn.disabled = true;/);
});
