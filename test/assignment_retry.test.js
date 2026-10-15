import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildApprovalHandoff } from '../lib/approval_handoff.js';

function setup(emit) {
  const handlers = {}, elements = {};
  const event = buildApprovalHandoff({ workflowId: 'wf_retry', planHash: 'a'.repeat(32), submissionId: 'sub_retry', title: '换人', nodes: [{ id: 'verify', defaultAgent: 'browser-agent', assignedAgent: 'hanako-lite' }] });
  const select = { value: 'hanako-lite', dataset: { nodeId: 'verify' }, options: [{ text: '轻装粉哥', value: 'hanako-lite' }], selectedIndex: 0,
    style: {}, addEventListener() {} };
  const element = id => elements[id] ||= { style: {}, dataset: {}, textContent: '', classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener(name, fn) { handlers[id + ':' + name] = fn; } };
  const document = { documentElement: { scrollHeight: 50 }, body: { scrollHeight: 50 },
    getElementById: id => ['svg-connections', 'dag-container', 'dag-viewport'].includes(id) ? null : element(id),
    querySelectorAll: () => [select], addEventListener() {} };
  const response = { ok: true, ...event, approvalEvent: event };
  let posts = 0;
  const hana = { emit, ui: { resize() {} }, api: { fetch: async () => { posts++; return { ok: true, status: 200, json: async () => response }; } } };
  const source = readFileSync(new URL('../ui/assets/workflow-ui.js', import.meta.url), 'utf8');
  runInNewContext(source.replace('export function initializeWorkflow', 'function initializeWorkflow') + '\ninitializeWorkflow(data, hana);', {
    window: { addEventListener() {} }, document, data: { workflowId: event.workflowId, edges: [] }, hana, setTimeout() {}
  });
  async function click() {
    handlers['btn-submit:click']();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  return { click, event, elements, posts: () => posts };
}

test('首次回传尚未完成时拒绝重复点击，失败后同凭据重试且最终人员不变', async () => {
  let resolveEmit;
  const emitted = [];
  const ui = setup((name, payload) => {
    emitted.push({ name, payload });
    return new Promise(resolve => { resolveEmit = resolve; });
  });
  await ui.click();
  await ui.click();
  assert.equal(emitted.length, 1);
  assert.equal(ui.posts(), 1);
  resolveEmit({ delivered: false });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await ui.click();
  assert.equal(emitted.length, 2);
  assert.equal(ui.posts(), 1);
  assert.deepEqual(emitted[1].payload, emitted[0].payload);
  assert.equal(emitted[1].payload.assignments.verify, 'hanako-lite');
  resolveEmit({ delivered: true });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.match(ui.elements['btn-text'].textContent, /已发送最终分工/);
});
