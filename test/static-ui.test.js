import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execute} from '../tools/render_workflow.js';
import {apply} from '../index.js';
import {renderWorkflowPage} from '../lib/theme.js';
import {normalizeNodes,buildDagPlan} from '../lib/dag.js';
import {resolveAgentRoster} from '../lib/agents.js';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
function inventory(p){const out=[];for(const n of readdirSync(p)){const x=join(p,n);if(statSync(x).isDirectory())out.push(...inventory(x));else out.push([x,createHash('sha256').update(readFileSync(x)).digest('hex')]);}return out;}
test('packaged route exists and SDK loader has no latest or navigation fallback',()=>{const m=JSON.parse(readFileSync(join(root,'manifest.json')));assert.equal(m.contributes.cards[0].route,'/workflow.html');assert.ok(statSync(join(root,'ui/workflow.html')).isFile());const l=readFileSync(join(root,'ui/assets/workflow-loader.js'),'utf8');assert.match(l,/getAll\('workflowId'\)/);assert.match(l,/data.workflowId !== workflowId/);assert.ok(!l.includes('location.replace'));assert.ok(!l.includes("|| 'latest'"));assert.ok(!l.includes('eval('));});
test('two tool calls bind distinct workflow IDs and only write dataDir',async()=>{const before=inventory(root);const d=mkdtempSync(join(tmpdir(),'wf-static-'));try{const a=await execute({title:'A',nodes:[{id:'a',title:'A'}]},{dataDir:d,sessionPath:'host-path-A'});const b=await execute({title:'B',nodes:[{id:'b',title:'B'}]},{dataDir:d,sessionPath:'host-path-B'});const parse=r=>new URL(r.details.card.route,'https://host.invalid').searchParams.get('workflowId');assert.notEqual(parse(a),parse(b));for(const [r,s] of [[a,'host-path-A'],[b,'host-path-B']]){const rec=JSON.parse(readFileSync(join(d,'workflows',parse(r)+'.json')));assert.equal(rec.sessionPath,s);}assert.deepEqual(inventory(root),before);}finally{rmSync(d,{recursive:true,force:true});}});
test('entry uses per-call host context and never persists callToken',async()=>{let tool;await apply({dataDir:'mock',logger:{},tools:{register:async t=>{tool=t;}},routes:{register:async()=>{}}});assert.equal(tool.invocationStyle,'sdk_tool');const d=mkdtempSync(join(tmpdir(),'wf-context-'));try{await apply({dataDir:d,tools:{register:async t=>{tool=t;}},routes:{register:async()=>{}}});const r=await tool.execute({title:'ctx',nodes:[{id:'a',title:'A'}],context:{sessionPath:'host-stamped',callToken:'DO-NOT-STORE'}});const id=new URL(r.details.card.route,'https://test.invalid').searchParams.get('workflowId');const text=readFileSync(join(d,'workflows',id+'.json'),'utf8');assert.ok(text.includes('host-stamped'));assert.ok(!text.includes('DO-NOT-STORE'));}finally{rmSync(d,{recursive:true,force:true});}});
test('dynamic markup carries inert instance JSON only and escapes malicious text',()=>{const rec={id:'wf_safe',title:'<img src=x onerror=alert(1)>',nodes:[{id:'a',title:'A'}]};const plan=buildDagPlan(normalizeNodes(rec.nodes));const html=renderWorkflowPage(rec,plan,resolveAgentRoster());assert.match(html,/<script type="application\/json" id="workflow-data">/);assert.ok(!html.includes('(function()'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&lt;img'));});
test('static client sends through SDK and drops legacy/manual credentials',()=>{const js=readFileSync(join(root,'ui/assets/workflow-ui.js'),'utf8');assert.match(js,/hana.api.fetch/);assert.ok(!js.includes('/api/plugins/'));assert.ok(!js.includes('X-Hana-Plugin-Surface-Session'));assert.ok(!js.includes('window.parent.postMessage'));});
