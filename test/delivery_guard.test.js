import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import registerWorkflowRoutes, { readWorkflowRecord } from '../http/workflow.js';

function fixture(agent = 'hanako-lite') {
  const dir = mkdtempSync(join(tmpdir(), 'wf-guard-v24-'));
  mkdirSync(join(dir, 'workflows'));
  const id = 'wf_guard_test';
  const path = join(dir, 'workflows', `${id}.json`);
  const record = {
    id,
    title: '守卫测试工作流',
    description: '测试契约边界',
    status: 'idle',
    approvalGranted: false,
    nodes: [
      {
        id: 'step1',
        title: '任务A',
        task: '做任务',
        boundary: '只读',
        outputs: '产物',
        acceptance: '通过',
        defaultAgent: agent,
        dependsOn: []
      }
    ]
  };
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');

  let postHandler;
  let getHandler;
  const busCalls = [];

  const mockApp = {
    get: (p, h) => { getHandler = h; },
    post: (p, h) => { postHandler = h; }
  };

  const mockCtx = {
    dataDir: dir,
    bus: {
      request: async (topic, payload) => {
        busCalls.push({ topic, payload });
        return { ok: true };
      }
    }
  };

  registerWorkflowRoutes(mockApp, mockCtx);

  const callPost = (body = {}) => {
    let resp = {};
    const c = {
      req: {
        param: () => id,
        json: async () => body,
        text: async () => JSON.stringify(body)
      },
      json: (data, status = 200) => { resp = { status, data }; return resp; }
    };
    return postHandler(c).then(() => resp);
  };

  return { dir, path, id, callPost, busCalls };
}

test('无 session bus 调用：POST execute 经过认证 UI API 持久化批准，绝不调用 session:send 或 session:list', async () => {
  const f = fixture('hanako-lite');
  try {
    const res = await f.callPost({ assignments: { step1: 'hanako-lite' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.planHash);
    assert.ok(res.data.submissionId);

    // 关键断言：绝对没有调用总线！busCalls 必须为 0
    assert.equal(f.busCalls.length, 0, 'POST execute 绝不能调用 session bus 总线');

    const saved = readWorkflowRecord(f.dir, f.id);
    assert.equal(saved.approvalGranted, true);
    assert.equal(saved.status, 'approved');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('白名单强校验：非法节点与未知专员被直接拦截 (400)', async () => {
  const f = fixture('hanako-lite');
  try {
    // 1. 试图为不存在的节点分配专员
    const resUnknownNode = await f.callPost({ assignments: { nonexistent_node: 'lange' } });
    assert.equal(resUnknownNode.status, 400);
    assert.equal(resUnknownNode.data.error, 'unknown_assignment_node');

    // 2. 试图分配未知专员
    const resUnknownAgent = await f.callPost({ assignments: { step1: 'malicious_agent' } });
    assert.equal(resUnknownAgent.status, 400);
    assert.equal(resUnknownAgent.data.error, 'invalid_agent_assignment');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('已批准方案不得静默改负责人：修改 assignments 触发 409 冲突拦截', async () => {
  const f = fixture('hanako-lite');
  try {
    // 1. 首次批准为 hanako-lite
    const res1 = await f.callPost({ assignments: { step1: 'hanako-lite' } });
    assert.equal(res1.status, 200);
    const originalHash = res1.data.planHash;

    // 2. 试图静默改负责人为 hajimi -> 必须拒绝
    const res2 = await f.callPost({ assignments: { step1: 'hajimi' } });
    assert.equal(res2.status, 409);
    assert.equal(res2.data.error, 'plan_already_approved_conflict');
    assert.match(res2.data.message, /禁止静默修改负责人/);

    // 3. 再次传入相同 assignments -> 幂等通过，沿用相同 submissionId
    const res3 = await f.callPost({ assignments: { step1: 'hanako-lite' } });
    assert.equal(res3.status, 200);
    assert.equal(res3.data.planHash, originalHash);
    assert.equal(res3.data.submissionId, res1.data.submissionId);
    assert.equal(res3.data.idempotent, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('相同方案重发自动沿用原 submissionId，禁止客户端自行伪造 submissionId', async () => {
  const f = fixture('hanako-lite');
  try {
    const res1 = await f.callPost({ assignments: { step1: 'hanako-lite' } });
    assert.equal(res1.status, 200);
    const serverSubId = res1.data.submissionId;
    assert.ok(serverSubId.startsWith('sub_'));

    // 客户端即使试图在 body 伪造 submissionId，服务端也必须沿用合法的原 submissionId
    const res2 = await f.callPost({ assignments: { step1: 'hanako-lite' }, submissionId: 'sub_client_forged_999' });
    assert.equal(res2.status, 200);
    assert.equal(res2.data.submissionId, serverSubId, '服务端必须坚持使用权威生成的 submissionId');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('旧版 delivery_unknown 历史记录安全锁定：一律 423 拒绝，不可自动重发', async () => {
  const f = fixture('hanako-lite');
  try {
    const record = readWorkflowRecord(f.dir, f.id);
    record.status = 'delivery_unknown';
    record.locked = true;
    writeFileSync(f.path, JSON.stringify(record, null, 2), 'utf-8');

    const res = await f.callPost({});
    assert.equal(res.status, 423);
    assert.equal(res.data.error, 'delivery_unknown_locked');
    assert.match(res.data.message, /旧版投递未决历史记录/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('UI 脚本符合快捷回复架构：无 to 参数，缺宿主绝不伪造成功，锁定选择器防换人误发', () => {
  const source = readFileSync(new URL('../ui/assets/workflow-ui.js', import.meta.url), 'utf8');

  // 1. 无 to 参数回传
  assert.match(source, /hana\.emit\("workflow\.approved",\s*payload\)/);
  assert.match(source, /window\.card\.emit\("workflow\.approved",\s*payload\)/);
  assert.doesNotMatch(source, /hana\.emit\("workflow\.approved",\s*payload,\s*to\)/);

  // 2. 缺宿主 bridge 时必须 reject / 明确 requires_host，绝对禁止伪造成功
  assert.match(source, /requires_host/);
  assert.match(source, /Promise\.reject/);

  // 3. 严格分支校验：hana.emit 只认可 delivered===true，window.card.emit 只认可 ok===true
  assert.match(source, /res\s*&&\s*res\.delivered\s*===\s*true/);
  assert.match(source, /res\s*&&\s*res\.ok\s*===\s*true/);

  // 4. 方案获批后物理锁定选择器，防止改人误发旧方案
  assert.match(source, /lockConfiguration/);
  assert.match(source, /s\.disabled\s*=\s*true/);
  assert.match(source, /btnAddAgent\.disabled\s*=\s*true/);
});
