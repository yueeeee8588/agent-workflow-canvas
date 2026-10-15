import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { Buffer } from 'node:buffer';
import registerRoutes, { readWorkflowRecord } from '../http/workflow.js';
import { getApprovedWorkflowRecord, consumeApprovedWorkflowRecord } from '../lib/approval_gate.js';
import { buildApprovalHandoff, MAX_APPROVAL_EVENT_BYTES } from '../lib/approval_handoff.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wf-assignment-'));
  mkdirSync(join(dir, 'workflows'));
  const record = {
    id: 'wf_assignment', title: '换人回归', description: '最终选择优先', status: 'idle',
    nodes: [{ id: 'verify', title: '核查', task: '只读核查', defaultAgent: 'browser-agent', dependsOn: [] }]
  };
  writeFileSync(join(dir, 'workflows', record.id + '.json'), JSON.stringify(record));
  const routes = new Map();
  registerRoutes({ get: (p, h) => routes.set('GET ' + p, h), post: (p, h) => routes.set('POST ' + p, h) }, { dataDir: dir });
  async function call(method, suffix = '', body = {}) {
    const key = `${method} /workflow/:id${suffix}`;
    return routes.get(key)({
      req: { param: () => record.id, text: async () => JSON.stringify(body) },
      json: (data, status = 200) => ({ data, status }),
      html: data => ({ data, status: 200 }), text: (data, status = 200) => ({ data, status })
    });
  }
  return { dir, record, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pageData(html) {
  return JSON.parse(html.match(/<script type="application\/json" id="workflow-data">([\s\S]*?)<\/script>/)[1]);
}

// Run the real UI module against a minimal DOM + actual backend routes.
// This verifies event transport, not LLM compliance or actual worker execution.
function client(data, fetcher, branch = 'hana') {
  const elements = new Map();
  function element(id) {
    const handlers = {};
    return { id, handlers, dataset: {}, style: {}, value: '', textContent: '', disabled: false,
      options: [{ value: 'browser-agent', text: '网页执行官 (browser-agent)' }], selectedIndex: 0,
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener(name, callback) { handlers[name] = callback; },
      querySelector() { return null; }, appendChild() {}, focus() {} };
  }
  const select = element('agent-verify'); select.dataset.nodeId = 'verify'; select.value = 'browser-agent';
  const document = {
    documentElement: { scrollHeight: 100 }, body: { scrollHeight: 100 }, addEventListener() {},
    getElementById(id) {
      if (['dag-viewport', 'svg-connections', 'dag-container'].includes(id)) return null;
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    querySelectorAll: () => [select]
  };
  const events = [], requests = [];
  const hana = { ui: { resize() {} }, api: { fetch: async (path, options) => {
    requests.push({ path, options });
    const r = await fetcher(path, options);
    return { ok: r.status === 200, status: r.status, json: async () => r.data };
  } } };
  const window = { addEventListener() {} };
  if (branch === 'hana') hana.emit = async (name, payload) => { events.push({ name, payload }); return { delivered: true }; };
  if (branch === 'card') window.card = { emit: async (name, payload) => { events.push({ name, payload }); return { ok: true }; } };
  const source = readFileSync(new URL('../ui/assets/workflow-ui.js', import.meta.url), 'utf8');
  runInNewContext(source.replace('export function initializeWorkflow', 'function initializeWorkflow')
    + '\ninitializeWorkflow(data, hana);', { window, document, data, hana, setTimeout() {} });
  async function click() {
    document.getElementById('btn-submit').handlers.click();
    // Drain promise callbacks from actual UI handlers without sleeping.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  return { select, events, requests, click, elements, hana };
}

test('换人 → 后端批准 → UI emit → get/consume 全链路保留最终负责人', async () => {
  const f = fixture();
  try {
    const initial = pageData((await f.call('GET')).data);
    const ui = client(initial, (path, options) => f.call('POST', '/execute', JSON.parse(options.body)));
    ui.select.value = 'hanako-lite';
    await ui.click();
    assert.equal(ui.events.length, 1);
    const event = ui.events[0].payload;
    assert.equal(ui.events[0].name, 'workflow.approved');
    assert.equal(event.assignments.verify, 'hanako-lite');
    assert.match(event.instructions, /不得用旧分工/);
    assert.match(event.instructions, /subagent_reply/);
    assert.match(event.instructions, /已经派发但未核销/);
    assert.deepEqual(event.requiredToolCalls.map(c => c.tool), ['get_approved_workflow', 'consume_workflow_approval']);
    assert.equal(event.requiredToolCalls[0].arguments.planHash, event.planHash);
    assert.equal(event.requiredToolCalls[1].arguments.submissionId, event.submissionId);
    const approved = getApprovedWorkflowRecord(f.dir, event.workflowId, event.planHash);
    assert.equal(approved.nodes[0].defaultAgent, 'browser-agent');
    assert.equal(approved.nodes[0].assignedAgent, 'hanako-lite');
    const claimed = consumeApprovedWorkflowRecord(f.dir, event.workflowId, event.planHash, event.submissionId);
    assert.equal(claimed.nodes[0].assignedAgent, 'hanako-lite');
    assert.equal(claimed.duplicate, false);
    assert.equal(consumeApprovedWorkflowRecord(f.dir, event.workflowId, event.planHash, event.submissionId).duplicate, true);
    assert.equal(ui.select.disabled, true);
  } finally { f.cleanup(); }
});

test('首次批准、幂等响应、刷新数据、重复点击回传同一最终名单', async () => {
  const f = fixture();
  try {
    const first = (await f.call('POST', '/execute', { assignments: { verify: 'hanako-lite' } })).data;
    const retry = (await f.call('POST', '/execute', { assignments: { verify: 'hanako-lite' } })).data;
    const reload = pageData((await f.call('GET')).data);
    const approved = (await f.call('GET', '/approval')).data.data;
    assert.deepEqual(retry.approvalEvent, first.approvalEvent);
    assert.deepEqual(reload.approvalEvent, first.approvalEvent);
    assert.deepEqual(approved.approvalEvent, first.approvalEvent);
    const ui = client(reload, () => { throw new Error('重发不应覆盖批准记录'); });
    ui.select.value = 'browser-agent'; // Programmatic DOM changes must not replace the backend decision.
    await ui.click(); await ui.click();
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.events.length, 2);
    for (const event of ui.events) assert.deepEqual(JSON.parse(JSON.stringify(event.payload)), first.approvalEvent);
  } finally { f.cleanup(); }
});

test('旧已批准页面仅有三个编号时从后台恢复，下一次点击按新协议发送', async () => {
  const f = fixture();
  try {
    await f.call('POST', '/execute', { assignments: { verify: 'hanako-lite' } });
    const data = pageData((await f.call('GET')).data); delete data.approvalEvent;
    const ui = client(data, () => f.call('GET', '/approval'));
    await ui.click();
    assert.equal(ui.events.length, 0, '恢复后等下一次用户手势，禁止自动重发');
    assert.match(ui.requests[0].path, /\/approval$/);
    await ui.click();
    assert.equal(ui.events[0].payload.assignments.verify, 'hanako-lite');
  } finally { f.cleanup(); }
});

test('window.card.emit 回退通道同样携带最终人员；无宿主不伪造投递', async () => {
  const f = fixture();
  try {
    await f.call('POST', '/execute', { assignments: { verify: 'hanako-lite' } });
    const data = pageData((await f.call('GET')).data);
    const ui = client(data, () => { throw new Error('unexpected fetch'); }, 'card');
    await ui.click();
    assert.equal(ui.events[0].payload.assignments.verify, 'hanako-lite');
    const offline = client(data, () => {}, 'none');
    await offline.click();
    assert.equal(offline.events.length, 0);
    assert.match(offline.elements.get('alert-modal-msg').textContent, /requires_host/);
  } finally { f.cleanup(); }
});

test('无最终人员的旧批准响应不再发出只有编号的事件', async () => {
  const f = fixture();
  try {
    const initial = pageData((await f.call('GET')).data);
    const ui = client(initial, async () => ({ status: 200, data: { ok: true, workflowId: f.record.id, planHash: 'x', submissionId: 'y' } }));
    await ui.click();
    assert.equal(ui.events.length, 0);
    assert.equal(ui.select.disabled, true);
    assert.match(ui.elements.get('alert-modal-msg').textContent, /最终人员/);
  } finally { f.cleanup(); }
});

test('已领取的工作流刷新不再次发送；指纹不匹配不回传可执行名单', async () => {
  const f = fixture();
  try {
    const res = (await f.call('POST', '/execute', { assignments: { verify: 'hanako-lite' } })).data;
    consumeApprovedWorkflowRecord(f.dir, res.workflowId, res.planHash, res.submissionId);
    const ui = client(pageData((await f.call('GET')).data), () => { throw new Error('unexpected fetch'); });
    await ui.click();
    assert.equal(ui.events.length, 0);
    const rec = readWorkflowRecord(f.dir, f.record.id); rec.nodes[0].assignedAgent = 'hajimi';
    writeFileSync(join(f.dir, 'workflows', rec.id + '.json'), JSON.stringify(rec));
    assert.equal(pageData((await f.call('GET')).data).approvalEvent, null);
    assert.equal(getApprovedWorkflowRecord(f.dir, rec.id).hashMismatch, true);
  } finally { f.cleanup(); }
});

test('8KiB 上限按 UTF-8 字节计算；超大名单整体省略且保留读取指令', () => {
  const base = { workflowId: 'wf_large', planHash: 'a'.repeat(32), submissionId: 'sub_test', title: '最终选择' };
  const normal = buildApprovalHandoff({ ...base, nodes: [{ id: 'step1', assignedAgent: 'hanako-lite', defaultAgent: 'browser-agent' }] });
  assert.equal(normal.assignments.step1, 'hanako-lite');
  assert.ok(Buffer.byteLength(JSON.stringify(normal)) <= MAX_APPROVAL_EVENT_BYTES);
  const large = buildApprovalHandoff({ ...base, title: '超长说明'.repeat(2000), nodes: Array.from({ length: 1000 }, (_, i) => ({ id: 'step_' + i, defaultAgent: 'hanako-lite' })) });
  assert.equal(large.assignmentsOmitted, true);
  assert.equal(large.nodeCount, 1000);
  assert.equal(large.assignments, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= MAX_APPROVAL_EVENT_BYTES);
  assert.match(large.instructions, /get_approved_workflow/);
});

test('未知自定义专员批准后刷新仍保留最终选择与回传', async () => {
  const f = fixture();
  try {
    const res = (await f.call('POST', '/execute', {
      assignments: { verify: 'custom-evaluator' }, customAgents: [{ id: 'custom-evaluator', name: '自定义专员' }]
    })).data;
    assert.equal(res.approvalEvent.assignments.verify, 'custom-evaluator');
    const reloaded = pageData((await f.call('GET')).data);
    assert.equal(reloaded.approvalEvent.assignments.verify, 'custom-evaluator');
  } finally { f.cleanup(); }
});
