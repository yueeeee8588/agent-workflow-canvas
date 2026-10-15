/**
 * render_workflow V2.4 工具实现
 * 遵循协同 5.0 规范：显式 DAG 拓扑、Work Package 属性约束、Shared Write 冲突阻止、
 * 快捷回复卡片回传架构：生成卡片立即返回，不再需要 sessionId/path 查找作为路由条件，
 * 动态 Agents 快照显式标注（不伪称实时）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkflowInput, validateWorkflowId, SecurityValidationError } from "../lib/security.js";
import { normalizeNodes, buildDagPlan } from "../lib/dag.js";
import { resolveAgentRoster } from "../lib/agents.js";
import { renderWorkflowPage } from "../lib/theme.js";

export const name = "render_workflow";
export const description =
  "多Agent协作工作流画布：两类情况必须出图（岳明确要求派发分身，或重大复杂任务需要规划）。先展示目标、工作包、执行者、依赖、权限与验收，生成卡片后立即返回；等待用户在卡片中审阅并确认方案，通过快捷回复卡片架构持久化审批并由宿主回传事件；生成与展示均不等于批准，未批准前不得启动图中执行分身或主控施工。支持DAG、换人、共享写冲突检测。";

export const parameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "可选：当前宿主会话标识 (仅用于元数据审计，非路由必需)"
    },
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
    summary: "Write a workflow DAG record under plugin data so the interactive card can render immediately.",
    ruleId: "plugin-output-workflow-record"
  })
};

export async function execute(input, ctx = {}) {
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

  // 6. 生成安全的工作流标识符 (防路径穿越)
  const safeRand = randomUUID().replace(/-/g, "").slice(0, 8);
  const workflowId = `wf_${Date.now().toString(36)}_${safeRand}`;
  validateWorkflowId(workflowId);

  // 7. 审计记录：提取上下文信息用于日志与审计追踪（非路由硬条件）
  const auditSessionId = (typeof input?.sessionId === "string" && input.sessionId.trim()) ||
    (typeof ctx.sessionId === "string" && ctx.sessionId.trim()) ||
    (typeof ctx.sessionRef?.sessionId === "string" && ctx.sessionRef.sessionId.trim()) ||
    null;

  const auditSessionPath = (typeof ctx.sessionPath === "string" && ctx.sessionPath.trim()) ||
    (typeof ctx.sessionRef?.sessionPath === "string" && ctx.sessionRef.sessionPath.trim()) ||
    null;

  // 8. 构造持久化工作流实体 (严禁误标 executed=true，初始状态为待批准)
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
    status: "idle",
    submitted: false,
    executed: false,
    approvalRequired: true,
    approvalGranted: false,
    consumed: false,
    consumedAt: null,
    planHash: null,
    submissionId: null,
    sessionId: auditSessionId,
    sessionPath: auditSessionPath,
    sessionRef: ctx.sessionRef || null
  };

  // 9. 写入存储目录
  const dir = join(ctx.dataDir, "workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${workflowId}.json`), JSON.stringify(record, null, 2), "utf-8");

  // 更新 latest 索引 (供兜底使用)
  const latestData = { workflowId, ts: new Date().toISOString() };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(latestData, null, 2), "utf-8");

  // 10. 自动预渲染静态水墨 HTML 至 UI 目录
  try {
    const pageHtml = renderWorkflowPage(record, dagPlan, agentRoster);
    if (ctx.dataDir) {
      const dataUiDir = join(ctx.dataDir, "ui", "workflow");
      if (!existsSync(dataUiDir)) mkdirSync(dataUiDir, { recursive: true });
      writeFileSync(join(dataUiDir, workflowId), pageHtml, "utf-8");
      writeFileSync(join(dataUiDir, `${workflowId}.html`), pageHtml, "utf-8");

      const hostAppsDir = join(ctx.dataDir, "..", "..", "apps", "agent-workflow-canvas", "ui", "workflow");
      const currentAppDir = fileURLToPath(new URL("..", import.meta.url));
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

  // 11. 构建终端可读回传计划摘要
  const conflictText = dagPlan.conflicts.length > 0
    ? `\n⚠️ 【状态并发防护】检测到 ${dagPlan.conflicts.length} 处共享写入冲突，已自动安全串行化规避。`
    : "";

  const text = `【协作规划看板已生成（等待审批）】\n`
    + `• 标题: ${title}\n`
    + `• 派发路线: ${dagPlan.dispatchLane} (${dagPlan.laneReason})\n`
    + `• 拓扑状态: 共 ${dagPlan.stats.totalNodes} 个任务节点，${dagPlan.stats.totalLayers} 个执行阶段，最大并发度 ${dagPlan.stats.maxConcurrency}\n`
    + `• 专员名单快照: ${agentRoster.label}${conflictText}\n`
    + `• 工作流标识: ${workflowId}\n`
    + `卡片已立即呈现。请审阅边界与验收、选择各工作包负责人，并在卡片中点击确认；确认后将通过快捷回复卡片架构在后端持久化凭据并向宿主回传事件。当前画布等待审批，生成与展示均不等于批准，未批准前不启动图中分身或施工。\n`
    + `收到 workflow.approved 事件后，用户可能已在画布换人：必须先调用 get_approved_workflow(workflowId, planHash) 读取最终方案，核对批准状态、指纹及 submissionId，再调用 consume_workflow_approval 核销；按返回 nodes 的 assignedAgent 优先派发，不得直接沿用本轮出图时的 defaultAgent 或历史分工。重复领取先核查已有任务，不重复派发。`;

  // 12. 立即返回卡片详情 (不再强制依赖 sessionId 路由条件)
  return {
    content: [{ type: "text", text }],
    details: {
      card: {
        id: "workflow",
        pluginId: "agent-workflow-canvas",
        type: "webview",
        route: `/workflow.html?workflowId=${encodeURIComponent(workflowId)}`,
        title,
        description: description || title
      }
    }
  };
}
