import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';
import { execute as renderWorkflowExecute, description } from '../tools/render_workflow.js';
import { getApprovedWorkflowTool, consumeWorkflowApprovalTool } from '../tools/approval_tools.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-contract-v24-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('manifest requests clean capabilities and removes pre-execute hook and session management', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  // 必须移除会话锁与总线会话管理权限
  assert.equal(manifest.capabilities.includes('app/hooks.tools-pre-execute'), false, '必须移除 tools/pre-execute 钩子');
  assert.equal(manifest.capabilities.includes('app/session.start-turn'), true, 'hana.emit 唤醒 Agent 必须声明起回合能力；该能力不是会话锁');
  assert.equal(manifest.capabilities.includes('app/sessions.manage'), false, '必须移除 sessions.manage');

  // 保留合法的标准能力
  assert.ok(manifest.capabilities.includes('app/tools.expose-to-model'));
  assert.ok(manifest.capabilities.includes('app/resources.read'));
  assert.ok(manifest.capabilities.includes('app/resources.write'));
  assert.equal(manifest.version, '2.4.2');
  assert.ok(manifest.icon.startsWith('data:image/svg+xml;base64,'), '应用图标必须采用 Base64 Data URI');
});

test('apply: 成功注册三个模型工具，不再强依赖 pre-execute 钩子，不锁会话', async () => {
  const registeredTools = new Map();
  let registeredRoutes = false;

  const mockCtx = {
    dataDir: tmpdir(),
    tools: {
      register: async (toolDef) => {
        registeredTools.set(toolDef.name, toolDef);
      }
    },
    routes: {
      register: (cb) => {
        registeredRoutes = true;
      }
    }
  };

  await apply(mockCtx);

  assert.equal(registeredRoutes, true);
  assert.ok(registeredTools.has('render_workflow'), '必须注册 render_workflow');
  assert.ok(registeredTools.has('get_approved_workflow'), '必须注册 get_approved_workflow');
  assert.ok(registeredTools.has('consume_workflow_approval'), '必须注册 consume_workflow_approval');
});

test('render_workflow: 任何生成的计划均立即返回并处于待批状态 (出图即待批)', async () => {
  const f = fixture();
  try {
    const result = await renderWorkflowExecute(
      {
        title: '全栈重构协同方案',
        description: '微服务拆分',
        nodes: [
          {
            id: 'design',
            title: '系统拆分',
            task: '设计服务间契约',
            boundary: '只读设计',
            outputs: '架构文档',
            acceptance: '契约完备',
            defaultAgent: 'lange'
          }
        ]
      },
      { dataDir: f.dir }
    );

    // 1. 生成卡片立即返回
    assert.ok(result.details?.card);
    assert.equal(result.details.card.id, 'workflow');
    assert.match(result.details.card.route, /\/workflow\.html\?workflowId=wf_/);

    // 2. 计划落盘状态严格为待批准，未误标 executed=true
    const { workflowId } = JSON.parse(readFileSync(join(f.dir, 'workflows', 'latest.json'), 'utf8'));
    const rec = JSON.parse(readFileSync(join(f.dir, 'workflows', `${workflowId}.json`), 'utf8'));

    assert.equal(rec.approvalRequired, true);
    assert.equal(rec.approvalGranted, false);
    assert.equal(rec.status, 'idle');
    assert.equal(rec.submitted, false);
    assert.equal(rec.executed, false);
    assert.equal(rec.consumed, false);

    // 3. 终端文案明确提示待审批
    assert.match(result.content[0].text, /协作规划看板已生成（等待审批）/);
    assert.match(result.content[0].text, /当前画布等待审批，生成与展示均不等于批准/);
  } finally {
    f.cleanup();
  }
});

test('无会话身份正常呈现：render_workflow 不依赖 sessionId，无会话时正常出图', async () => {
  const f = fixture();
  try {
    // 传入完全空的 ctx 与 input (无 sessionId, 无 sessionPath)
    const result = await renderWorkflowExecute(
      {
        title: '独立纯净工作流',
        nodes: [{ id: 'task1', title: '单人任务', defaultAgent: 'hanako-lite' }]
      },
      { dataDir: f.dir }
    );

    assert.ok(result.details?.card);
    assert.equal(result.details.card.route.includes('workflowId=wf_'), true);
    assert.equal(result.details.card.route.includes('sessionId'), false);
  } finally {
    f.cleanup();
  }
});

test('双卡隔离：连续调用 render_workflow 产生不同的 workflowId，完全独立隔离', async () => {
  const f = fixture();
  try {
    const card1 = await renderWorkflowExecute(
      { title: '看板A', nodes: [{ id: 'a', title: 'A', defaultAgent: 'hanako-lite' }] },
      { dataDir: f.dir }
    );
    const card2 = await renderWorkflowExecute(
      { title: '看板B', nodes: [{ id: 'b', title: 'B', defaultAgent: 'hajimi' }] },
      { dataDir: f.dir }
    );

    const route1 = card1.details.card.route;
    const route2 = card2.details.card.route;
    assert.notEqual(route1, route2);

    const id1 = route1.split('workflowId=')[1];
    const id2 = route2.split('workflowId=')[1];
    assert.notEqual(id1, id2);

    const rec1 = JSON.parse(readFileSync(join(f.dir, 'workflows', `${id1}.json`), 'utf8'));
    const rec2 = JSON.parse(readFileSync(join(f.dir, 'workflows', `${id2}.json`), 'utf8'));
    assert.equal(rec1.title, '看板A');
    assert.equal(rec2.title, '看板B');
  } finally {
    f.cleanup();
  }
});
