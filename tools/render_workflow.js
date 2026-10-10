/**
 * render_workflow V2 工具实现
 * 遵循协同 5.0 规范：显式 DAG 拓扑、Work Package 属性约束、Shared Write 冲突阻止、
 * 固定卡片路由防串卡、动态 Agents 快照显式标注（不伪称实时）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkflowInput, validateWorkflowId, SecurityValidationError } from "../lib/security.js";
import { normalizeNodes, buildDagPlan } from "../lib/dag.js";
import { resolveAgentRoster } from "../lib/agents.js";
import { renderWorkflowPage } from "../lib/theme.js";
import { resolveSessionIdFromPath } from "../lib/session_resolver.js";

export const name = "render_workflow";
export const description =
  "多Agent协作工作流画布：粉哥hanako仅两类强制画布审批：岳主动要求派发分身，或重大复杂任务需要规划（主控独立执行也适用）。先展示目标、工作包、执行者、依赖、权限与验收，等待岳明确批准已展示方案后才派发/施工；首次要求、生成投递、推荐项和后台回调不算批准，禁止先派后补图及批准前新建/续接受影响分身或施工。重大方案变化重新画布待批，工具不可用停在边界；两类之外普通自主派发按收益。粉哥排错至少实际派发一人推荐多角度，命中门禁批准后履行。其他Agent按其个人契约判断，不新增审批。批准不扩权，外部状态独立授权。粉哥本批派发后交权，终态统一恢复；严格挂起须宿主支持并实测，插件不提供此能力，未支持时wait_for_tasks兼容等待。支持DAG、换人、共享写冲突检测。";

export const parameters = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "工作流标题，例如「全栈系统重构与分布式流水线协同」"
    },
    description: {
      type: "string",
      description: "工作流背景目标或协同说明"
    },
    nodes: {
      type: "array",
      description: "DAG 节点列表（支持显式 dependsOn 依赖数组与 Work Package 完整属性）",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "节点唯一标识，如 step1, test_a, test_b, review"
          },
          tag: {
            type: "string",
            description: "阶段角标，如 Phase 1, Worker A, Gatekeeper"
          },
          title: {
            type: "string",
            description: "节点任务标题"
          },
          task: {
            type: "string",
            description: "任务具体工作内容"
          },
          desc: {
            type: "string",
            description: "历史兼容器：任务简述（若无 task 则使用本字段）"
          },
          boundary: {
            type: "string",
            description: "工作边界与权限限制（如：只读分析/禁止动生产配置/上下文隔离）"
          },
          outputs: {
            type: "string",
            description: "预期输出产物（如：提取的表格 Markdown、测试用例脚本）"
          },
          acceptance: {
            type: "string",
            description: "必要验收条件（如：所有测试通过且无破坏性改动）"
          },
          writeTargets: {
            type: "array",
            items: { type: "string" },
            description: "写入目标或修改的共享资源列表（用于 Shared Write 并发冲突拦截）"
          },
          technicalUnknown: {
            type: "boolean",
            description: "是否存在技术未知需要独立取证（协同 5.0 Worker Lane 判定依据）"
          },
          contextIsolation: {
            type: "boolean",
            description: "是否需要隔离主会话上下文以防污染（协同 5.0 Worker Lane 判定依据）"
          },
          independentValue: {
            type: "boolean",
            description: "是否存在明显独立拆分收益（若全为 false 则判定为 Direct Lane）"
          },
          defaultAgent: {
            type: "string",
            description: "推荐执行角色 (如：lead / architect / coder / reviewer / devops / browser / ui-designer / analyst 等通用工程角色)"
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "前置依赖的节点 ID 列表。例如 ['step1']"
          },
          column: {
            type: "integer",
            description: "历史兼容字段：阶段列序号（若未提供 dependsOn，将按 column 自动转换为前序全连通依赖）"
          }
        },
        required: ["id", "title"]
      },
      minItems: 1
    },
    agents: {
      type: "array",
      description: "可选：由外部 agent_manager list 等提供的专员快照名单（明确快照来源，不伪称实时）",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          desc: { type: "string" },
          permission: { type: "string" }
        },
        required: ["id", "name"]
      }
    }
  },
  required: ["title", "nodes"]
};

export const sessionPermission = {
  kind: "plugin_output",
  describeSideEffect: () => ({
    kind: "plugin_output",
    summary: "Write a workflow DAG record under plugin data so the interactive card can render and deliver execution commands back to the session.",
    ruleId: "plugin-output-workflow-record"
  })
};

export async function execute(input, ctx) {
  // 1. 安全与边界校验
  const { title, description, rawNodes } = validateWorkflowInput(input);

  // 2. 解析可用 Agent 阵容快照并前置校验
  const agentRoster = resolveAgentRoster(input.agents || null);
  const validAgentIds = new Set(agentRoster.agents.map((a) => a.id));

  // 3. 规范化并校验 DAG 依赖结构（防自依赖、防未知依赖、防循环死锁、旧 column 兼容）
  const normalizedNodes = normalizeNodes(rawNodes);

  // 4. 创建时严格校验每个节点的 defaultAgent 是否在有效名录中（未指定时兜底为通用 coder）
  for (const node of normalizedNodes) {
    if (!node.defaultAgent) {
      node.defaultAgent = "coder";
    }
    if (!validAgentIds.has(node.defaultAgent)) {
      throw new SecurityValidationError(
        `节点 [${node.id}] 指定了未在专员名录中的未知默认专员: "${node.defaultAgent}"。请指定合法专员标识。`,
        "UNKNOWN_DEFAULT_AGENT"
      );
    }
  }

  // 5. 拓扑分层、Shared Write 冲突检测与派发模式推导
  const dagPlan = buildDagPlan(normalizedNodes);

  // 5. 生成安全的工作流标识符 (防路径穿越)
  const safeRand = randomUUID().replace(/-/g, "").slice(0, 8);
  const workflowId = `wf_${Date.now().toString(36)}_${safeRand}`;
  validateWorkflowId(workflowId);

  // 5.1 解析宿主真实的 sessionId (解决 legacySessionPath 无法寻址导致报错)
  let resolvedSessionId = ctx.sessionId || null;
  if (!resolvedSessionId && ctx.sessionPath) {
    try {
      resolvedSessionId = await resolveSessionIdFromPath(ctx.sessionPath, ctx.dataDir, ctx.bus);
    } catch {
      resolvedSessionId = null;
    }
  }

  // 6. 构造持久化工作流实体
  const record = {
    id: workflowId,
    title,
    description,
    nodes: dagPlan.nodes,
    dagPlan: {
      dispatchLane: dagPlan.dispatchLane,
      laneReason: dagPlan.laneReason,
      conflicts: dagPlan.conflicts,
      stats: dagPlan.stats
    },
    agentSnapshot: input.agents || null,
    agentSnapshotLabel: agentRoster.label,
    createdAt: new Date().toISOString(),
    submitted: false,
    executed: false,
    sessionId: resolvedSessionId,
    sessionRef: ctx.sessionRef || null,
    sessionPath: ctx.sessionPath || null
  };

  // 7. 写入存储目录
  const dir = join(ctx.dataDir, "workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${workflowId}.json`), JSON.stringify(record, null, 2), "utf-8");

  // 更新 latest 索引 (供兜底使用)
  const latestData = { workflowId, ts: new Date().toISOString() };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(latestData, null, 2), "utf-8");

  // 7.1 自动预渲染静态水墨 HTML 至 UI 目录 (兼容宿主静态文件读取，同时绝不污染只读源码树)
  try {
    const pageHtml = renderWorkflowPage(record, dagPlan, agentRoster);
    if (ctx.dataDir) {
      const dataUiDir = join(ctx.dataDir, "ui", "workflow");
      if (!existsSync(dataUiDir)) mkdirSync(dataUiDir, { recursive: true });
      writeFileSync(join(dataUiDir, workflowId), pageHtml, "utf-8");
      writeFileSync(join(dataUiDir, `${workflowId}.html`), pageHtml, "utf-8");

      const hostAppsDir = join(ctx.dataDir, "..", "..", "apps", "agent-workflow-canvas", "ui", "workflow");
      const currentAppDir = fileURLToPath(new URL("..", import.meta.url));
      // 仅当目标不是当前应用源码目录且真实宿主安装目录存在时同步写入
      if (resolve(hostAppsDir) !== resolve(join(currentAppDir, "ui", "workflow")) && existsSync(join(ctx.dataDir, "..", "..", "apps", "agent-workflow-canvas"))) {
        if (!existsSync(hostAppsDir)) mkdirSync(hostAppsDir, { recursive: true });
        writeFileSync(join(hostAppsDir, workflowId), pageHtml, "utf-8");
        writeFileSync(join(hostAppsDir, `${workflowId}.html`), pageHtml, "utf-8");
      }
    }
  } catch (renderErr) {
    ctx.log?.warn?.("static html pre-render failed", renderErr?.message);
  }

  ctx.log?.info?.(`[render_workflow] 工作流已创建: ${workflowId} (${dagPlan.dispatchLane})`);

  // 8. 构建终端可读回传计划摘要
  const conflictText = dagPlan.conflicts.length > 0
    ? `\n⚠️ 【状态并发防护】检测到 ${dagPlan.conflicts.length} 处共享写入冲突，已自动安全串行化规避。`
    : "";

  const text = `【可选协作规划看板已生成】\n`
    + `• 标题: ${title}\n`
    + `• 派发路线: ${dagPlan.dispatchLane} (${dagPlan.laneReason})\n`
    + `• 拓扑状态: 共 ${dagPlan.stats.totalNodes} 个任务节点，${dagPlan.stats.totalLayers} 个执行阶段，最大并发度 ${dagPlan.stats.maxConcurrency}\n`
    + `• 专员名单快照: ${agentRoster.label}${conflictText}\n`
    + `• 工作流标识: ${workflowId} (静态页面按此标识读取独立数据，不使用latest代替绑定)\n`
    + `可审阅边界与验收、选择负责人并提交计划意图；运行中换人须先确认原执行者完成或停止再核查现场。提交不证明已派发或完成，不扩大权限。粉哥hanako若属岳主动要求分身或重大复杂任务需规划，生成本画布后必须交回岳，等待明确批准已展示方案才派发/施工；批准前仅许主控必要已授权只读检查，禁止先派后补图或后台绕行。两类之外及其他Agent按个人契约；画布回执不是批准。`;

  return {
    content: [{ type: "text", text }],
    details: {
      card: {
        id: "workflow",
        pluginId: "agent-workflow-canvas",
        type: "webview",
        // 关键改动：card.id 严格对齐 manifest contributes 声明 (workflow)，通过独立 route 隔离实例防串卡
        route: `/workflow.html?workflowId=${encodeURIComponent(workflowId)}`,
        title,
        description: description || title
      }
    }
  };
}
