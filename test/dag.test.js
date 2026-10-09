import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNodes, buildDagPlan, DagValidationError } from "../lib/dag.js";

test("DAG - 基础显式 dependsOn 拓扑分层", () => {
  const rawNodes = [
    { id: "step1", title: "需求分析", defaultAgent: "lead", dependsOn: [] },
    { id: "step2a", title: "后端实现", defaultAgent: "coder", dependsOn: ["step1"] },
    { id: "step2b", title: "前端界面", defaultAgent: "ui-designer", dependsOn: ["step1"] },
    { id: "step3", title: "集成验收", defaultAgent: "reviewer", dependsOn: ["step2a", "step2b"] }
  ];

  const normalized = normalizeNodes(rawNodes);
  assert.equal(normalized.length, 4);

  const plan = buildDagPlan(normalized);
  assert.equal(plan.layers.length, 3, "应分为3个拓扑层级");
  assert.equal(plan.layers[0].nodes.length, 1, "第1层应有1个节点 (step1)");
  assert.equal(plan.layers[1].nodes.length, 2, "第2层应有2个并发节点 (step2a, step2b)");
  assert.equal(plan.layers[2].nodes.length, 1, "第3层应有1个汇聚节点 (step3)");
  assert.equal(plan.dispatchLane, "Matrix Lane", "并发度为2时应判定为 Matrix Lane");
});

test("DAG - 循环依赖检测必须抛出 CYCLE_DEPENDENCY_ERROR 并指明环路", () => {
  const cycleNodes = [
    { id: "nodeA", title: "A", dependsOn: ["nodeC"] },
    { id: "nodeB", title: "B", dependsOn: ["nodeA"] },
    { id: "nodeC", title: "C", dependsOn: ["nodeB"] }
  ];

  assert.throws(
    () => normalizeNodes(cycleNodes),
    (err) => {
      assert(err instanceof DagValidationError);
      assert.equal(err.code, "CYCLE_DEPENDENCY_ERROR");
      assert(err.message.includes("循环依赖"));
      return true;
    }
  );
});

test("DAG - 自依赖检测与未知依赖检测", () => {
  // 自依赖
  assert.throws(
    () => normalizeNodes([{ id: "self1", title: "自恋节点", dependsOn: ["self1"] }]),
    (err) => {
      assert.equal(err.code, "SELF_DEPENDENCY_ERROR");
      return true;
    }
  );

  // 未知依赖
  assert.throws(
    () => normalizeNodes([{ id: "normal", title: "正常", dependsOn: ["non_existent_id"] }]),
    (err) => {
      assert.equal(err.code, "UNKNOWN_DEPENDENCY_ERROR");
      return true;
    }
  );

  // 重复节点 ID
  assert.throws(
    () => normalizeNodes([
      { id: "dup", title: "重复1", dependsOn: [] },
      { id: "dup", title: "重复2", dependsOn: [] }
    ]),
    (err) => {
      assert.equal(err.code, "DUPLICATE_NODE_ID");
      return true;
    }
  );
});

test("DAG - 旧 column 结构平滑兼容转为前序全依赖", () => {
  const legacyNodes = [
    { id: "p1", title: "列1节点", column: 1 },
    { id: "p2a", title: "列2分叉A", column: 2 },
    { id: "p2b", title: "列2分叉B", column: 2 },
    { id: "p3", title: "列3汇集", column: 3 }
  ];

  const normalized = normalizeNodes(legacyNodes);
  assert.deepEqual(normalized[0].dependsOn, []);
  assert.deepEqual(normalized[1].dependsOn, ["p1"]);
  assert.deepEqual(normalized[2].dependsOn, ["p1"]);
  assert.deepEqual(normalized[3].dependsOn.sort(), ["p2a", "p2b"]);

  const plan = buildDagPlan(normalized);
  assert.equal(plan.layers.length, 3);
  assert.equal(plan.dispatchLane, "Matrix Lane");
});

test("DAG - Work Package 完整属性兜底解析", () => {
  const nodes = [
    {
      id: "wp1",
      title: "核心开发",
      task: "重构核心通信管道",
      boundary: "禁止动外围路由",
      outputs: "管道抽象层与单元测试",
      acceptance: "测试覆盖率100%",
      writeTargets: ["src/pipeline.js"]
    }
  ];

  const normalized = normalizeNodes(nodes);
  assert.equal(normalized[0].task, "重构核心通信管道");
  assert.equal(normalized[0].boundary, "禁止动外围路由");
  assert.equal(normalized[0].outputs, "管道抽象层与单元测试");
  assert.equal(normalized[0].acceptance, "测试覆盖率100%");
  assert.deepEqual(normalized[0].writeTargets, ["src/pipeline.js"]);

  const plan = buildDagPlan(normalized);
  assert.equal(plan.dispatchLane, "Worker Lane", "单一节点指派施工专员 coder 应判定为 Worker Lane");
});

test("DAG - Shared Write 冲突阻止并发与自动安全串行化", () => {
  // 两节点本属于同一拓扑层（均依赖 root），但都写 "config/app.json"
  const nodes = [
    { id: "root", title: "初始化", dependsOn: [] },
    {
      id: "workerA",
      title: "模块A配置更新",
      dependsOn: ["root"],
      writeTargets: ["config/app.json"]
    },
    {
      id: "workerB",
      title: "模块B配置更新",
      dependsOn: ["root"],
      writeTargets: ["config/app.json"]
    }
  ];

  const normalized = normalizeNodes(nodes);
  const plan = buildDagPlan(normalized);

  assert.equal(plan.conflicts.length, 1, "必须检测到 1 处 Shared Write 冲突");
  assert.equal(plan.conflicts[0].sharedResources[0], "config/app.json");

  // workerB 必须被强制追加依赖 workerA 进行串行化保护
  const workerB = plan.nodes.find((n) => n.id === "workerB");
  assert(workerB.dependsOn.includes("workerA"), "workerB 应自动依赖 workerA 以规避冲突");
  assert(workerB.layer > plan.nodes.find((n) => n.id === "workerA").layer, "workerB 层级应在 workerA 之后");
});

test("DAG - 全局可达性 Shared Write 跨层无先后路径冲突与路径规范化消解", () => {
  // 节点结构：
  // root -> branch1
  // branch2 (无前置，与 branch1 互不可达，原本不同层且无路径)
  // branch1 写 "./SRC\\Core\\App.js"
  // branch2 写 "src/core/app.js" (反斜杠、大小写、相对路径不同)
  const nodes = [
    { id: "root", title: "根初始化", dependsOn: [] },
    {
      id: "branch1",
      title: "分支1施工",
      dependsOn: ["root"],
      writeTargets: ["./SRC\\Core\\App.js"]
    },
    {
      id: "branch2",
      title: "分支2并发任务",
      dependsOn: [],
      writeTargets: ["src/core/app.js"]
    }
  ];

  const normalized = normalizeNodes(nodes);
  const plan = buildDagPlan(normalized);

  assert.equal(plan.conflicts.length, 1, "跨层无路径但资源重叠必须全局检测出冲突");
  assert.equal(plan.conflicts[0].sharedResources[0], "src/core/app.js", "写入目标必须完全规范化为统一格式");

  // branch2 在后声明，必须被建立无环串行边依赖 branch1 (或按先后声明顺序)
  const laterNode = plan.nodes.find((n) => n.id === "branch2");
  assert(laterNode.dependsOn.includes("branch1"), "branch2 应建立全局串行边依赖 branch1 以消解并发写冲突");
});

test("DAG - 派发路线协同 5.0 精准选择 (Direct / Worker / Matrix)", () => {
  // 1. 单个普通节点无未知 -> Direct Lane
  const planDirectSingle = buildDagPlan(normalizeNodes([
    { id: "single", title: "简单文字排版", defaultAgent: "lead", dependsOn: [] }
  ]));
  assert.equal(planDirectSingle.dispatchLane, "Direct Lane");

  // 2. 多个节点但声明无独立拆分收益 -> Direct Lane
  const planMultiNoValue = buildDagPlan(normalizeNodes([
    { id: "n1", title: "改文案1", defaultAgent: "lead", dependsOn: [], independentValue: false },
    { id: "n2", title: "改文案2", defaultAgent: "lead", dependsOn: ["n1"], independentValue: false }
  ]));
  assert.equal(planMultiNoValue.dispatchLane, "Direct Lane", "无独立收益应判定为 Direct Lane");

  // 3. 单个节点指定专项专家 (如 domain-specialist / analyst) -> Worker Lane
  const planSpecialistWorker = buildDagPlan(normalizeNodes([
    { id: "rehab_task", title: "深蹲运动解剖推演", defaultAgent: "domain-specialist", dependsOn: [] }
  ]));
  assert.equal(planSpecialistWorker.dispatchLane, "Worker Lane", "指派专项专员应判定为 Worker Lane");

  // 4. 单个节点存在技术未知或需要上下文隔离 -> Worker Lane
  const planUnknownWorker = buildDagPlan(normalizeNodes([
    { id: "spike", title: "底层总线协议探针实验", technicalUnknown: true, dependsOn: [] }
  ]));
  assert.equal(planUnknownWorker.dispatchLane, "Worker Lane", "技术未知取证应判定为 Worker Lane");

  // 5. 多个有价值独立包正交并发 -> Matrix Lane
  const planMatrix = buildDagPlan(normalizeNodes([
    { id: "a", title: "模块A测试", defaultAgent: "coder", dependsOn: [] },
    { id: "b", title: "模块B审查", defaultAgent: "reviewer", dependsOn: [] }
  ]));
  assert.equal(planMatrix.dispatchLane, "Matrix Lane", "正交无冲突独立包应判定为 Matrix Lane");
});

test("Agents - 全量内置专员名录与快照解析", async () => {
  const { resolveAgentRoster, BUILTIN_AGENTS_5_0 } = await import("../lib/agents.js");

  // 1. 验证内置名录完整覆盖核心工程角色与专业专员
  assert(BUILTIN_AGENTS_5_0.length >= 9, "通用专员名录应包含标准角色");
  const ids = BUILTIN_AGENTS_5_0.map((a) => a.id);
  const requiredIds = [
    "lead", "architect", "coder", "reviewer", "devops", "browser", "ui-designer", "analyst", "domain-specialist"
  ];
  for (const rid of requiredIds) {
    assert(ids.includes(rid), `必须包含核实的通用专员 ID: ${rid}`);
  }

  // 验证 coder 显示名为全栈开发
  const coderAgent = BUILTIN_AGENTS_5_0.find((a) => a.id === "coder");
  assert(coderAgent.name.includes("全栈开发"), "coder 显示名必须包含全栈开发");

  // 验证权限明确为职责说明
  assert(coderAgent.permission.includes("职责"), "内置名录明确为职责说明");

  // 2. 默认快照解析 (本地探测或内置通用名录兜底)
  const defaultRoster = resolveAgentRoster();
  assert(["builtin_default", "local_hybrid"].includes(defaultRoster.source), "来源必须是内置默认或本地混合探测");
  assert(typeof defaultRoster.label === "string" && defaultRoster.label.length > 0, "必须提供非空的 label 显示标签");
  assert(defaultRoster.agents.length >= 9, "专员名录总数不得少于9个通用角色");

  // 3. 外部传入快照优先解析 (如从 agent_manager list 传入)
  const customRoster = resolveAgentRoster([
    { id: "worker-custom", name: "自定义专员", desc: "专责测试", permission: "只读" }
  ]);
  assert.equal(customRoster.source, "snapshot");
  assert.equal(customRoster.label, "会话专员快照", "外部快照 label 必须为会话专员快照");
  assert.equal(customRoster.agents.length, 1);
  assert.equal(customRoster.agents[0].id, "worker-custom");
});

test("DAG - 写路径漏检修复与 '.' 工作区根目录重叠冲突消解", async () => {
  const { normalizeResourceTarget, isResourceOverlap } = await import("../lib/dag.js");

  // 1. 规范化测试："."、"src/.." 解析为工作区根标记 "."
  assert.equal(normalizeResourceTarget("."), ".");
  assert.equal(normalizeResourceTarget("./"), ".");
  assert.equal(normalizeResourceTarget("src/.."), ".");
  assert.equal(normalizeResourceTarget("a/b/../../"), ".");

  // 绝对路径根保留为 "/"
  assert.equal(normalizeResourceTarget("/"), "/");
  assert.equal(normalizeResourceTarget("/app/.."), "/");

  // 2. isResourceOverlap 边界测试
  // "." 与任何工作区相对路径均重叠冲突
  assert.equal(isResourceOverlap(".", "src/app.js"), true);
  assert.equal(isResourceOverlap("package.json", "."), true);
  assert.equal(isResourceOverlap(".", "."), true);

  // "/" 与任何绝对路径冲突
  assert.equal(isResourceOverlap("/", "/etc/config"), true);
  assert.equal(isResourceOverlap("/var/log", "/"), true);

  // 3. 在 buildDagPlan 中验证 "." 导致的两节点写冲突串行化
  const nodes = [
    { id: "root", title: "初始化", dependsOn: [] },
    { id: "modA", title: "修改根配置", dependsOn: ["root"], writeTargets: ["src/.."] },
    { id: "modB", title: "更新具体文件", dependsOn: ["root"], writeTargets: ["src/index.js"] }
  ];
  const normalized = normalizeNodes(nodes);
  const plan = buildDagPlan(normalized);

  assert.equal(plan.conflicts.length, 1, "必须检测到工作区根 '.' 与 'src/index.js' 的共享写入冲突");
  const modB = plan.nodes.find((n) => n.id === "modB");
  assert(modB.dependsOn.includes("modA"), "modB 必须自动串行依赖 modA");
});

