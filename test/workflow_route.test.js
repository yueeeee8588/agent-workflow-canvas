import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import registerWorkflowRoutes, {
  readWorkflowRecord,
  buildExecutionDispatchText
} from "../http/workflow.js";
import { normalizeNodes, buildDagPlan } from "../lib/dag.js";
import { calculatePlanHash } from "../lib/approval_gate.js";

// 构造轻量 Mock App 容器 (支持具体路径优先匹配)
function createMockApp() {
  const routes = { GET: new Map(), POST: new Map() };
  return {
    routes,
    get(path, handler) { routes.GET.set(path, handler); },
    post(path, handler) { routes.POST.set(path, handler); },
    async dispatch(method, path, { params = {}, body = null } = {}) {
      let handler = routes[method].get(path);
      if (!handler) {
        if (path.endsWith("/approval")) {
          handler = routes[method].get("/workflow/:id/approval");
        } else if (path.endsWith("/execute")) {
          handler = routes[method].get("/workflow/:id/execute");
        } else if (path.endsWith("/approve")) {
          handler = routes[method].get("/workflow/:id/approve");
        } else if (path.startsWith("/workflow/")) {
          handler = routes[method].get("/workflow/:id");
        }
      }
      if (!handler) throw new Error(`Route not found: ${method} ${path}`);

      let response = { status: 200, type: "none", data: null };
      const c = {
        req: {
          param: (k) => params[k] || path.split("/").pop(),
          json: async () => body || {},
          text: async () => JSON.stringify(body || {})
        },
        html: (content, status = 200) => { response = { status, type: "html", data: content }; return response; },
        text: (content, status = 200) => { response = { status, type: "text", data: content }; return response; },
        json: (content, status = 200) => { response = { status, type: "json", data: content }; return response; }
      };

      return await handler(c);
    }
  };
}

function setupTempWorkflowData() {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-canvas-test-"));
  const wfDir = join(tempDir, "workflows");
  mkdirSync(wfDir, { recursive: true });

  const record = {
    id: "wf_test_001",
    title: "测试流水线",
    description: "协同5.0测试任务",
    nodes: [
      {
        id: "step1",
        tag: "Phase 1",
        title: "分析需求",
        task: "梳理输入",
        boundary: "只读",
        outputs: "需求列表",
        acceptance: "明确清晰",
        defaultAgent: "hanako-lite",
        dependsOn: []
      },
      {
        id: "step2",
        tag: "Phase 2",
        title: "独立验收",
        task: "执行把关",
        boundary: "只读",
        outputs: "验收报告",
        acceptance: "无遗漏",
        defaultAgent: "hajimi",
        dependsOn: ["step1"]
      }
    ],
    status: "idle",
    submitted: false,
    executed: false,
    approvalGranted: false,
    locked: false
  };

  writeFileSync(join(wfDir, "wf_test_001.json"), JSON.stringify(record, null, 2), "utf-8");
  return { tempDir, record };
}

test("DispatchText - 必须基于 dagPlan.nodes 全量要素且删除固定试错次数", () => {
  const rawNodes = [
    { id: "p1", title: "任务1", task: "做架构", boundary: "无写权限", outputs: "架构图", acceptance: "评审通过", defaultAgent: "lange", column: 1 },
    { id: "p2", title: "任务2", task: "做施工", boundary: "沙箱落地", outputs: "代码", acceptance: "测试通过", defaultAgent: "hanako-lite", column: 2 }
  ];
  const dagPlan = buildDagPlan(normalizeNodes(rawNodes));
  const text = buildExecutionDispatchText({ id: "wf_demo", title: "演示工作流" }, dagPlan);

  // 1. 严禁包含硬编码的“3-5次试错”
  assert(!text.includes("3-5次试错"), "必须删除硬编码的3-5次试错");

  // 2. 调度契约核心规范回归 (全部 7 大契约)
  assert(text.includes("两类情况必须出图"));
  assert(text.includes("出图即待批"));
  assert(text.includes("未批准不得启动或续接图中分身"));
  assert(text.includes("wait_for_tasks"));
  assert(text.includes("先处理不依赖结果的剩余工作"));
  assert(text.includes("等待期间可正常说明进度"));
  assert(!text.includes("ok go on"));
  assert(!text.includes("保活输出"));
  assert(!text.includes("单任务通知不得提前唤醒"));
  assert(!text.includes("不得称严格挂起"));
  assert(text.includes("一包一执行者"));
  assert(text.includes("busy不得同包接管"));
  assert(text.includes("分级审查原则"));
  assert(!text.includes("一票否决"));
  assert(text.includes("权限与隔离底线"));
  assert(text.includes("验收交付"));
  assert(text.includes("Stage 1"));
  assert(text.includes("Stage 2"));
  assert(text.includes("显式前置依赖: [p1]"));
});

test("Route - GET /workflow/:id 旧节点规范化后完整回填至渲染页面", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-legacy-test-"));
  const wfDir = join(tempDir, "workflows");
  mkdirSync(wfDir, { recursive: true });

  const legacyRecord = {
    id: "wf_legacy",
    title: "旧版兼容工作流",
    nodes: [
      { id: "col1", title: "首阶段", column: 1, defaultAgent: "hanako-lite" },
      { id: "col2", title: "次阶段", column: 2, defaultAgent: "hajimi" }
    ]
  };
  writeFileSync(join(wfDir, "wf_legacy.json"), JSON.stringify(legacyRecord, null, 2), "utf-8");

  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    const res = await app.dispatch("GET", "/workflow/wf_legacy", { params: { id: "wf_legacy" } });
    assert.equal(res.status, 200);
    assert(res.data.includes("前置依赖:</span>"));
    assert(res.data.includes("col1"), "旧节点渲染页面必须展示推导出依赖 col1");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute 经过认证 UI API 持久化批准并返回稳定凭据 (无 session bus 调用)", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    let busCallCount = 0;

    const mockCtx = {
      dataDir: tempDir,
      bus: {
        request: async () => {
          busCallCount++;
          return { ok: true };
        }
      }
    };

    registerWorkflowRoutes(app, mockCtx);

    const res = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { step1: "hanako-lite", step2: "hajimi" } }
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.status, "approved");
    assert.ok(res.data.planHash);
    assert.ok(res.data.submissionId);
    assert.equal(busCallCount, 0, "绝不能调用 session bus 总线");

    const saved = readWorkflowRecord(tempDir, "wf_test_001");
    assert.equal(saved.status, "approved");
    assert.equal(saved.approvalGranted, true);
    assert.equal(saved.planHash, res.data.planHash);
    assert.equal(saved.submissionId, res.data.submissionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - 已批准方案不得静默改负责人，相同指纹支持幂等重试", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    // 1. 首次批准为 hanako-lite
    const res1 = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { step1: "hanako-lite" } }
    });
    assert.equal(res1.status, 200);
    const approvedHash = res1.data.planHash;

    // 2. 试图静默改负责人为 hajimi -> 拦截 409
    const resConflict = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { step1: "hajimi" } }
    });
    assert.equal(resConflict.status, 409);
    assert.equal(resConflict.data.error, "plan_already_approved_conflict");

    // 3. 相同方案幂等重发 -> 200 并返回已有凭据
    const resIdempotent = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { step1: "hanako-lite" } }
    });
    assert.equal(resIdempotent.status, 200);
    assert.equal(resIdempotent.data.planHash, approvedHash);
    assert.equal(resIdempotent.data.idempotent, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute assignments 白名单校验拦截非法节点与未知专员", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    // 1. 试图为不存在的节点分派
    const resBadNode = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { non_existent_node: "lange" } }
    });
    assert.equal(resBadNode.status, 400);
    assert.equal(resBadNode.data.error, "unknown_assignment_node");

    // 2. 试图分派给不在 roster 名录中的非法专员
    const resBadAgent = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: { assignments: { step1: "untrusted_hacker_agent" } }
    });
    assert.equal(resBadAgent.status, 400);
    assert.equal(resBadAgent.data.error, "invalid_agent_assignment");

    // 3. 携带合法的动态 customAgents，分派成功
    const resCustomAgent = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {
        assignments: { step1: "my-custom-evaluator" },
        customAgents: [
          { id: "my-custom-evaluator", name: "评估专员", desc: "专项打分" }
        ]
      }
    });
    assert.equal(resCustomAgent.status, 200);
    assert.equal(resCustomAgent.data.status, "approved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Tool - render_workflow details.card.id 必须严格等于 workflow 且 route 包含动态 ID", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-tool-test-"));
  try {
    const { execute: renderExecute } = await import("../tools/render_workflow.js");
    const mockCtx = { dataDir: tempDir };

    const result = await renderExecute({
      title: "挂载契约验证流",
      nodes: [
        { id: "step1", title: "任务1", defaultAgent: "hanako-lite" }
      ]
    }, mockCtx);

    assert(result.details && result.details.card);
    assert.equal(result.details.card.id, "workflow", "card.id 必须严格匹配 manifest contributes 中声明的 workflow");
    const cardUrl = new URL(result.details.card.route, "https://test.invalid");
    assert.equal(cardUrl.pathname, "/workflow.html");
    assert.match(cardUrl.searchParams.get("workflowId"), /^wf_[A-Za-z0-9_-]+$/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("UI - renderNodeCard 遇到未知专员时必须渲染显式禁用占位符且不静默选第一项", async () => {
  const { renderNodeCard } = await import("../lib/theme.js");
  const roster = [
    { id: "hanako-lite", name: "轻装粉哥", desc: "施工" },
    { id: "hajimi", name: "哈基米", desc: "审查" }
  ];

  const badNode = {
    id: "step_unknown",
    tag: "Phase 1",
    title: "未知专员任务",
    defaultAgent: "alien_agent_xyz",
    dependsOn: []
  };

  const html = renderNodeCard(badNode, roster);
  assert(html.includes("⚠️ 未知或未授权专员: [alien_agent_xyz] (请更换)"), "必须显示显式未知禁用占位符");
  assert(html.includes('value="" disabled selected'), "必须禁止静默选中首项");
});

test("Tool - render_workflow 创建时拦截未授权的未知 defaultAgent", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-unknown-agent-test-"));
  try {
    const { execute: renderExecute } = await import("../tools/render_workflow.js");
    const mockCtx = { dataDir: tempDir };

    await assert.rejects(
      async () => {
        await renderExecute({
          title: "非法专员流",
          nodes: [
            { id: "step1", title: "测试", defaultAgent: "non_existent_hacker_agent" }
          ]
        }, mockCtx);
      },
      (err) => {
        assert.equal(err.code, "UNKNOWN_DEFAULT_AGENT");
        assert(err.message.includes("non_existent_hacker_agent"));
        return true;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("UI - 渲染页面包含全量分组 optgroup 与自定义助手添加入口", async () => {
  const { renderWorkflowPage } = await import("../lib/theme.js");
  const { resolveAgentRoster } = await import("../lib/agents.js");

  const roster = resolveAgentRoster();
  const mockPlan = {
    dispatchLane: "Matrix Lane",
    laneReason: "测试分流",
    conflicts: [],
    layers: [
      {
        layerIndex: 0,
        stageTag: "Stage 1",
        nodes: [
          {
            id: "node_1",
            tag: "P1",
            title: "核心施工",
            task: "编写代码",
            boundary: "沙箱",
            outputs: "脚本",
            acceptance: "通过",
            defaultAgent: "hanako-lite",
            dependsOn: []
          }
        ]
      }
    ],
    edges: []
  };

  const pageHtml = renderWorkflowPage(
    { id: "wf_ui_test", title: "测试UI", description: "UI测试", executed: false, submitted: false, status: "idle" },
    mockPlan,
    roster
  );

  assert(pageHtml.includes("optgroup"), "必须使用 optgroup 进行分类展示");
  assert(pageHtml.includes("核心协同主力"), "必须包含核心协同主力分组");
  assert(pageHtml.includes("browser-agent"), "必须包含网页执行官专员");
  assert(pageHtml.includes("➕ 输入自定义助手 ID"), "必须包含自定义专员添加入口");
  assert(pageHtml.includes("id=\"btn-add-agent\""), "底部工具栏必须包含添加自定义助手按钮");
});

test("Route - GET /workflow/:id/approval 读取审批凭证详情", async () => {
  const { tempDir, record } = setupTempWorkflowData();
  try {
    const planHash = calculatePlanHash(record.id, record.nodes, record.title, record.description);
    record.approvalGranted = true;
    record.status = "approved";
    record.planHash = planHash;
    record.submissionId = "sub_audit_123";
    writeFileSync(join(tempDir, "workflows", `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8");

    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    const res = await app.dispatch("GET", `/workflow/${record.id}/approval`, {
      params: { id: record.id }
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.approved, true);
    assert.equal(res.data.data.planHash, planHash);
    assert.equal(res.data.data.submissionId, "sub_audit_123");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
