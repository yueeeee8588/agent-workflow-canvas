import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import registerWorkflowRoutes, {
  readWorkflowRecord,
  buildExecutionDispatchText
} from "../http/workflow.js";
import { normalizeNodes, buildDagPlan } from "../lib/dag.js";

// 构造轻量 Mock App 容器
function createMockApp() {
  const routes = { GET: new Map(), POST: new Map() };
  return {
    routes,
    get(path, handler) { routes.GET.set(path, handler); },
    post(path, handler) { routes.POST.set(path, handler); },
    async dispatch(method, path, { params = {}, body = null } = {}) {
      let handler = routes[method].get(path);
      if (!handler) {
        for (const [routePath, h] of routes[method].entries()) {
          if (routePath.includes(":") && path.startsWith("/workflow/")) {
            handler = h;
            break;
          }
        }
      }
      if (!handler) throw new Error(`Route not found: ${method} ${path}`);

      let response = { status: 200, type: "none", data: null };
      const c = {
        req: {
          param: (k) => params[k] || path.split("/").pop(),
          json: async () => body || {}
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
        defaultAgent: "coder",
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
        defaultAgent: "reviewer",
        dependsOn: ["step1"]
      }
    ],
    status: "idle",
    submitted: false,
    executed: false,
    locked: false,
    sessionId: "sess_mock_123"
  };

  writeFileSync(join(wfDir, "wf_test_001.json"), JSON.stringify(record, null, 2), "utf-8");
  return { tempDir, record };
}

test("DispatchText - 必须基于 dagPlan.nodes 全量要素且删除固定试错次数", () => {
  const rawNodes = [
    { id: "p1", title: "任务1", task: "做架构", boundary: "无写权限", outputs: "架构图", acceptance: "评审通过", defaultAgent: "architect", column: 1 },
    { id: "p2", title: "任务2", task: "做施工", boundary: "沙箱落地", outputs: "代码", acceptance: "测试通过", defaultAgent: "coder", column: 2 }
  ];
  const dagPlan = buildDagPlan(normalizeNodes(rawNodes));
  const text = buildExecutionDispatchText({ id: "wf_demo", title: "演示工作流" }, dagPlan);

  // 1. 严禁包含硬编码的“3-5次试错”
  assert(!text.includes("3-5次试错"), "必须删除硬编码的3-5次试错，改为异常根因诊断与止损");

  // 2. 精简回报、所有权和行为验收不能被运行时提示覆盖
  assert(text.includes("状态、改动产物、验证证据、问题与假设"));
  assert(text.includes("一包一执行者"));
  assert(text.includes("主控不重复派出包施工"));
  assert(text.includes("busy不得同包接管"));
  assert(text.includes("自动执行触发变更默认独立复核"));
  assert(text.includes("构建不替代行为验收"));
  assert(text.includes("不强制三段交付"));
  assert(text.includes("必要只读取证"));
  assert(text.includes("默认等待用户亲自点击已展示计划"));
  assert(text.includes("审核前主控和子代理均不得施工"));
  assert(text.includes("主控全做也不能绕过审核"));
  assert(text.includes("更新图并重新等待发令"));
  assert(text.includes("一次性替代授权"));
  assert(text.includes("简单低风险集中任务轻量评估后直接做"));
  assert(text.includes("投递成功不证明已派发、完成或验收通过"));
  assert(!text.includes("不报调度、不强制工单或流程图"));
  assert(text.includes("同包不逐工具评估"));
  assert(text.includes("不一律转交用户"));
  assert(!text.includes("协同 5.0 运行时核心规约"));
  assert(!text.includes("并批准启动"));

  // 3. 必须包含会话复用、等待与权限底线，且为分级审查非一票否决
  assert(text.includes("wait_for_tasks"));
  assert(text.includes("分级审查原则"), "必须包含分级审查原则");
  assert(!text.includes("一票否决"), "不得强制一票否决");
  assert(text.includes("权限与隔离底线"));
  assert(text.includes("主会话") || text.includes("主控"), "主控不能硬编码固定粉哥");

  // 4. 必须包含各阶段最新分层与显式依赖
  assert(text.includes("Stage 1"));
  assert(text.includes("Stage 2"));
  assert(text.includes("显式前置依赖: [p1]"));
});

test("Route - GET /workflow/:id 旧节点规范化后完整回填至渲染页面", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-legacy-test-"));
  const wfDir = join(tempDir, "workflows");
  mkdirSync(wfDir, { recursive: true });

  // 模拟只有 column 没有 dependsOn 的旧数据
  const legacyRecord = {
    id: "wf_legacy",
    title: "旧版兼容工作流",
    nodes: [
      { id: "col1", title: "首阶段", column: 1, defaultAgent: "lead" },
      { id: "col2", title: "次阶段", column: 2, defaultAgent: "reviewer" }
    ],
    sessionId: "sess_mock"
  };
  writeFileSync(join(wfDir, "wf_legacy.json"), JSON.stringify(legacyRecord, null, 2), "utf-8");

  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    const res = await app.dispatch("GET", "/workflow/wf_legacy", { params: { id: "wf_legacy" } });
    assert.equal(res.status, 200);
    // 页面内卡片必须展示推导出的依赖
    assert(res.data.includes("前置依赖:</span>"));
    assert(res.data.includes("col1"), "旧节点渲染页面必须展示推导出依赖 col1");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute 发送前落盘 pending，且成功后更新为 submitted", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    let checkedPendingBeforeAck = false;

    const mockCtx = {
      dataDir: tempDir,
      sessionId: "sess_mock_123",
      bus: {
        request: async () => {
          // 在 bus 处理期间，立刻读取磁盘文件校验 pending 是否已落盘
          const midState = readWorkflowRecord(tempDir, "wf_test_001");
          if (midState && midState.status === "pending") {
            checkedPendingBeforeAck = true;
          }
          return { ok: true, id: "msg_ok" };
        }
      }
    };

    registerWorkflowRoutes(app, mockCtx);

    const res = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {}
    });

    assert.equal(res.status, 200);
    assert.equal(checkedPendingBeforeAck, true, "发送前必须已在磁盘落盘 status=pending");

    const saved = readWorkflowRecord(tempDir, "wf_test_001");
    assert.equal(saved.status, "submitted");
    assert.equal(saved.submitted, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute 宿主超时转为 delivery_unknown 锁定，后续请求一律 423 拒绝", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();

    const mockCtx = {
      dataDir: tempDir,
      sessionId: "sess_mock_123",
      bus: {
        request: async () => {
          throw new Error("Request to session bus timed out after 15000ms");
        }
      }
    };

    registerWorkflowRoutes(app, mockCtx);

    // 第一次调用发生超时
    const res1 = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {}
    });

    assert.equal(res1.status, 504);
    assert.equal(res1.data.error, "delivery_unknown");

    const saved = readWorkflowRecord(tempDir, "wf_test_001");
    assert.equal(saved.status, "delivery_unknown");
    assert.equal(saved.locked, true);

    // 第二次调用触发锁定防御，必须返回 423
    const res2 = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {}
    });
    assert.equal(res2.status, 423);
    assert.equal(res2.data.error, "delivery_unknown_locked");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute 宿主明确拒绝 (ok===false) 时回滚为 idle 且允许重试", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    let callCount = 0;

    const mockCtx = {
      dataDir: tempDir,
      sessionId: "sess_mock_123",
      bus: {
        request: async () => {
          callCount++;
          if (callCount === 1) {
            return { ok: false, error: "SESSION_RATE_LIMIT" };
          }
          return { ok: true, id: "msg_success" };
        }
      }
    };

    registerWorkflowRoutes(app, mockCtx);

    // 第一次调用收到明确拒绝
    const res1 = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {}
    });
    assert.equal(res1.status, 502);
    assert.equal(res1.data.error, "bus_rejected");

    // 磁盘记录已安全回滚为 idle
    const savedAfterFail = readWorkflowRecord(tempDir, "wf_test_001");
    assert.equal(savedAfterFail.status, "idle");
    assert.equal(savedAfterFail.submitted, false);

    // 第二次重试成功
    const res2 = await app.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {}
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.data.status, "submitted");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Route - POST execute assignments 白名单校验拦截非法节点与未知专员", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir, sessionId: "sess_mock" });

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

    // 3. 携带合法的动态 customAgents，分派成功 (提供 mock bus)
    const mockCtxWithBus = {
      dataDir: tempDir,
      sessionId: "sess_mock",
      bus: { request: async () => ({ ok: true }) }
    };
    const appWithBus = createMockApp();
    registerWorkflowRoutes(appWithBus, mockCtxWithBus);

    const resCustomAgent = await appWithBus.dispatch("POST", "/workflow/wf_test_001/execute", {
      params: { id: "wf_test_001" },
      body: {
        assignments: { step1: "my-custom-evaluator" },
        customAgents: [
          { id: "my-custom-evaluator", name: "评估专员", desc: "专项打分" }
        ]
      }
    });
    assert.equal(resCustomAgent.status, 200);
    assert.equal(resCustomAgent.data.status, "submitted");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Tool - render_workflow details.card.id 必须严格等于 workflow 且 route 包含动态 ID", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-tool-test-"));
  try {
    const { execute: renderExecute } = await import("../tools/render_workflow.js");
    const mockCtx = { dataDir: tempDir, sessionId: "sess_test" };

    const result = await renderExecute({
      title: "挂载契约验证流",
      nodes: [
        { id: "step1", title: "任务1", defaultAgent: "coder" }
      ]
    }, mockCtx);

    assert(result.details && result.details.card);
    assert.equal(result.details.card.id, "workflow", "card.id 必须严格匹配 manifest contributes 中声明的 workflow");
    assert(result.details.card.route.startsWith("/workflow/wf_"), "route 必须包含具体工作流 ID 进行防串卡隔离");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("UI - renderNodeCard 遇到未知专员时必须渲染显式禁用占位符且不静默选第一项", async () => {
  const { renderNodeCard } = await import("../lib/theme.js");
  const roster = [
    { id: "coder", name: "全栈开发", desc: "施工" },
    { id: "reviewer", name: "代码审查", desc: "审查" }
  ];

  // 节点拥有未在 roster 中的未知专员
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

  // 正常已知专员节点
  const goodNode = {
    id: "step_good",
    tag: "Phase 2",
    title: "正常任务",
    defaultAgent: "coder",
    dependsOn: []
  };
  const goodHtml = renderNodeCard(goodNode, roster);
  assert(!goodHtml.includes("⚠️ 未知或未授权专员"));
  assert(goodHtml.includes('value="coder" selected'));
});

test("Tool - render_workflow 创建时拦截未授权的未知 defaultAgent", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-unknown-agent-test-"));
  try {
    const { execute: renderExecute } = await import("../tools/render_workflow.js");
    const mockCtx = { dataDir: tempDir, sessionId: "sess_test" };

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
            defaultAgent: "coder",
            dependsOn: []
          }
        ]
      }
    ],
    edges: []
  };

  const pageHtml = renderWorkflowPage(
    { id: "wf_ui_test", title: "测试UI", description: "UI测试", executed: false, submitted: false },
    mockPlan,
    roster
  );

  assert(pageHtml.includes("optgroup"), "必须使用 optgroup 进行优雅分类展示");
  assert(pageHtml.includes("核心协同团队"), "必须包含核心协同团队分组");
  assert(pageHtml.includes("browser"), "必须包含网页执行官专员");
  assert(pageHtml.includes("➕ 输入自定义助手 ID"), "必须包含自定义专员添加入口");
  assert(pageHtml.includes("id=\"btn-add-agent\""), "底部工具栏必须包含添加自定义助手按钮");
});

test("Route - POST execute 非空非法 JSON 请求明确返回 400 invalid_json", async () => {
  const { tempDir } = setupTempWorkflowData();
  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir, sessionId: "sess_mock" });

    // 构造请求体非空但不是合法 JSON 的请求（通过带 text 方法的请求模拟）
    let customResponse = null;
    const cInvalidJson = {
      req: {
        param: () => "wf_test_001",
        text: async () => "{ invalid_json_content, missing_brackets: "
      },
      json: (data, status = 200) => { customResponse = { status, data }; return customResponse; }
    };

    const handler = app.routes.POST.get("/workflow/:id/execute");
    await handler(cInvalidJson);

    assert(customResponse !== null);
    assert.equal(customResponse.status, 400);
    assert.equal(customResponse.data.error, "invalid_json");
    assert(customResponse.data.message.includes("不是合法的 JSON 格式"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SSR - GET /workflow/:id delivery_unknown 状态下初始 HTML 按钮必须 disabled 且显示锁定文案", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-ssr-lock-"));
  const wfDir = join(tempDir, "workflows");
  mkdirSync(wfDir, { recursive: true });

  const lockedRecord = {
    id: "wf_locked_001",
    title: "锁定测试流",
    description: "测试页面重载状态",
    status: "delivery_unknown",
    locked: true,
    nodes: [
      { id: "step1", title: "测试步骤", defaultAgent: "coder", dependsOn: [] }
    ],
    sessionId: "sess_mock"
  };
  writeFileSync(join(wfDir, "wf_locked_001.json"), JSON.stringify(lockedRecord, null, 2), "utf-8");

  try {
    const app = createMockApp();
    registerWorkflowRoutes(app, { dataDir: tempDir });

    const res = await app.dispatch("GET", "/workflow/wf_locked_001", { params: { id: "wf_locked_001" } });
    assert.equal(res.status, 200);

    // 验证初始 SSR HTML 中的提交按钮渲染为 disabled
    assert(res.data.includes('id="btn-submit" disabled'), "初始 HTML 中的提交按钮必须渲染为 disabled");
    assert(res.data.includes("送达状态未决，请核实主会话"), "初始 HTML 按钮文本必须为送达状态未决，请核实主会话");
    assert(res.data.includes("var ALREADY_DONE = true;"), "初始脚本变量 ALREADY_DONE 必须为 true 防止刷新后重新点击");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});




