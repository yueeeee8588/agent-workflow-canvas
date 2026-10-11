/**
 * 工作流看板路由服务 (V2.4.0 快捷回复卡片架构)
 * 职责：
 * 1. 严格安全 ID 校验防路径穿越，支持 :id === "latest" 动态解析
 * 2. 独立固定路由 /workflow/:id 防止多卡片间串卡
 * 3. 认证 UI API 在后端验证负责人并持久化批准/方案指纹/服务端完整 submissionId
 *    (禁止客户端指定 submissionId，由服务端 randomUUID 全长度生成；submissionId 为公开去重标识，非权限凭据)
 *    (注：当前尚未接入官方网关深度校验，不伪造自制 Header 冒充防伪)
 * 4. 彻底切断总线 session:send、session:list/get 与投递锁
 * 5. 方案指纹 (planHash) 包含标题、说明、各工作包任务、边界、验收等全量契约字段
 * 6. 使用临时文件 + renameSync 原子替换写入磁盘，单进程防崩溃截断
 * 7. 幂等性保障：重试沿用原 submissionId，已批准方案不得静默改负责人
 * 8. 历史兼容：所有旧数据仍可读，但旧 delivery_unknown 历史记录不可自动再发
 * 9. assignments 严格白名单校验 (节点必须存在，专员必须在有效名录中，支持 customAgents)
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateWorkflowId, SecurityValidationError, sanitizeString } from "../lib/security.js";
import { buildDagPlan, normalizeNodes } from "../lib/dag.js";
import { resolveAgentRoster, isValidAgentId } from "../lib/agents.js";
import { renderWorkflowPage } from "../lib/theme.js";
import { calculatePlanHash, generateSubmissionId, getApprovedWorkflowRecord } from "../lib/approval_gate.js";

export function readWorkflowRecord(dataDir, id) {
  validateWorkflowId(id);
  const p = join(dataDir, "workflows", `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function readLatestRecord(dataDir) {
  const p = join(dataDir, "workflows", "latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 原子替换落盘，避免单进程崩溃产生残缺文件
 */
export function writeWorkflowRecord(dataDir, rec) {
  validateWorkflowId(rec.id);
  const dir = join(dataDir, "workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const targetPath = join(dir, `${rec.id}.json`);
  const tmpPath = join(dir, `${rec.id}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2), "utf-8");
  renameSync(tmpPath, targetPath);
}

/**
 * 组装发送给主会话与主 Agent 的完整调度契约文本 (2.3.6 原汁原味保留 7 大契约)
 * 基于经过分层与写冲突消解后的最终 dagPlan.nodes 全量呈现
 */
export function buildExecutionDispatchText(rec, dagPlan) {
  const nodesDetailLines = dagPlan.nodes.map((n) => {
    const agent = n.assignedAgent || n.defaultAgent || "coder";
    const depsStr = n.dependsOn && n.dependsOn.length > 0 ? n.dependsOn.join(", ") : "无 (起始节点)";
    const writeTarget = n.writeTargets && n.writeTargets.length > 0 ? ` [写入资源: ${n.writeTargets.join(", ")}]` : "";

    return `• 【${n.tag} · ${n.title}】(ID: ${n.id} | Stage ${n.layer + 1})\n`
      + `  - 显式前置依赖: [${depsStr}]\n`
      + `  - 分派专员: ${agent}\n`
      + `  - 任务内容: ${n.task || n.desc}\n`
      + `  - 权限边界: ${n.boundary}\n`
      + `  - 预期产物: ${n.outputs}\n`
      + `  - 验收条件: ${n.acceptance}${writeTarget}`;
  }).join("\n\n");

  const conflictNotice = dagPlan.conflicts.length > 0
    ? `\n\n【⚠️ 全局共享写入冲突串行化消解】\n` + dagPlan.conflicts.map((c) => `- ${c.reason}`).join("\n")
    : "";

  return `【审核发令已提交】用户已通过看板「🚀 立即执行」提交「${rec.title}」的已展示计划；主控核对真实发令来源、最终人员及当前权限后按本计划施工，投递成功不证明已派发、完成或验收通过。\n`
    + `派发路线: ${dagPlan.dispatchLane} (${dagPlan.laneReason})\n`
    + `拓扑规模: 共 ${dagPlan.stats.totalNodes} 个任务节点，${dagPlan.stats.totalLayers} 个执行阶段，最大并发度 ${dagPlan.stats.maxConcurrency}\n\n`
    + `【各工作包详细派发阵容与验收契约 (基于拓扑最新分层)】\n`
    + `${nodesDetailLines}${conflictNotice}\n\n`
    + `【Agent 调度与执行契约（评估与审核发令统一版）】\n`
    + `1. 评估与派发：施工前轻量确认目标、工具、权限、范围、依赖、共享资源与验收。粉哥hanako必须出画布的情形仅两类：岳主动要求分身，或重大复杂任务需规划（主控独立执行也适用）；岳岳在当前任务明确要求粉哥派发时或重大任务需规划时，必须先调用正式render_workflow展示目标、工作包、执行者、依赖、权限及验收，等待岳明确批准已展示方案后才派发/施工，所有默认派发、并发启动和批次恢复受此门禁约束。粉哥（Agent ID：hanako）排错必须实际派发至少一个子代理，推荐多角度并发多个，不固定要求两人，不能以问题简单免除派发，但命中门禁须批准后履行；搜索调研与项目了解按有效拆分收益。仅讨论或修改派发规则不触发当前启动子代理。两类之外不强制出图，尚未生成执行画布时按独立收益自主派发；粉哥无论任务类别，一旦生成执行画布就交回岳等待对已展示方案的明确批准，未批准不得启动或续接图中分身（只读也不例外）或主控执行方案，排错义务与后台消息均不解除等待。其他Agent按其个人契约判断，不新增必须出图条件。\n`
    + `2. 画布与发令：画布生成、展示与投递均不证明实际派发或批准；粉哥统一按“两类情况必须出图，出图即待批”执行，生成执行画布后本轮简短交代待批状态并交回岳，按规划→展示画布→岳明确批准已展示方案→派发/施工执行，首次要求派发、生成投递、推荐项及后台完成/回调均不等批准。批准前仅许主控形成方案必要且已授权的只读检查，严禁先派后补图、新建或续接受影响执行分身、抢先施工及通过工作流或后台绕行；已有相关任务要求在受影响边界前暂停并核验真实状态。画布不可用报告并停在审批边界，不以文字或选项卡替代。当前按钮提交只授权当前展示计划，不扩展后续任务范围；主控不得代替用户点击。已批准方案的工作包、负责人、重要依赖、范围或风险实质变化，更新画布重新等待批准；等价低风险细节自主处理。其他Agent按个人契约与正式发令协议。删除、外部状态修改、难以撤销风险与授权缺口仍独立确认。工具、权限受限如实说明，不伪造点击或派发。正交无冲突并行，依赖/共享写冲突串行，不因行数或工单长度单独拒绝，不凑人数。\n`
    + `3. 唯一负责人：一包一执行者，文件、配置、安装、构建、服务和端口均属共享状态；主控不重复派出包施工。接手前确认原执行者完成或停止且无继续写入的遗留任务再核查现场；pending不证失败，busy不得同包接管。\n`
    + `4. 会话复用与异步等待：简单工单自包含目标、边界与验收，同包用真实threadId续接。派发后保留真实task_id，先处理不依赖结果的剩余工作，需要结果时按真实依赖调用wait_for_tasks，不轮询或重复登记，无关任务不捆绑成全局门槛。等待期间可正常说明进度；结果返回后核验真实状态与稳定产物，失败或取消时说明尚未完成及原因，启动未确认时先核实，不盲目重派。用户插话、停止及子任务取消按当前授权和实际状态处理。\n`
    + `5. 分级审查原则：普通改动适用测试；认证、授权、目录边界、命令策略、自动执行触发变更默认独立复核。自测有价值但不替代复核，构建不替代行为验收；无代理或环境受限报告缺口/待测，不冒称通过，不擅自启用未充分验证的高风险变更，不一律转交用户。\n`
    + `6. 权限与隔离底线：以当前Agent有效规则和用户授权为准，计划按钮不扩大权限，子Agent只隔离上下文；执行者不顺手重构/新增依赖/扩大范围，关键歧义先取证或回报。\n`
    + `7. 验收交付：执行者回报状态、改动产物、验证证据、问题与假设；主控核查实际差异和适用测试。无新证据重复尝试停止，有诊断修复可继续，不固定次数。视觉按实际能力，审美由用户最终决定，用户看效果与回滚说明按需，不强制三段交付。`;
}

export default function registerWorkflowRoutes(app, ctx) {
  // 1. 最新看板路由
  app.get("/workflow", (c) => {
    const latest = readLatestRecord(ctx.dataDir);
    const id = latest && latest.workflowId ? latest.workflowId : null;
    if (!id) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:36px;color:#888;"><h3>暂无进行中的工作流看板</h3><p>请通过 render_workflow 工具创建协同流水线。</p></body></html>`);
    }
    const rec = readWorkflowRecord(ctx.dataDir, id);
    if (!rec) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:36px;color:#888;"><h3>未找到指定工作流 (${id})</h3></body></html>`);
    }

    const normalizedNodes = normalizeNodes(rec.nodes);
    const dagPlan = buildDagPlan(normalizedNodes);
    rec.nodes = dagPlan.nodes;

    const agentRoster = resolveAgentRoster(rec.agentSnapshot || null);
    return c.html(renderWorkflowPage(rec, dagPlan, agentRoster));
  });

  // 2. 独立固定路由 /workflow/:id/approval (必须优先匹配，避免被通配 :id 吞掉)
  app.get("/workflow/:id/approval", (c) => {
    let id = c.req.param("id");
    if (id === "latest") {
      const latest = readLatestRecord(ctx.dataDir);
      id = latest && latest.workflowId ? latest.workflowId : null;
      if (!id) return c.json({ ok: false, error: "not_found", message: "无最新工作流" }, 404);
    }

    try {
      validateWorkflowId(id);
    } catch (err) {
      return c.json({ ok: false, error: "invalid_id", message: err.message }, 400);
    }

    const info = getApprovedWorkflowRecord(ctx.dataDir, id);
    if (!info.found) {
      return c.json({ ok: false, error: "not_found", message: info.message }, 404);
    }
    return c.json({ ok: true, data: info }, 200);
  });

  // 3. 独立固定路由 /workflow/:id (防串卡，支持 latest)
  app.get("/workflow/:id", (c) => {
    let id = c.req.param("id");
    if (id === "latest") {
      const latest = readLatestRecord(ctx.dataDir);
      id = latest && latest.workflowId ? latest.workflowId : null;
      if (!id) {
        return c.text("未找到进行中的最新工作流", 404);
      }
    }

    let rec;
    try {
      rec = readWorkflowRecord(ctx.dataDir, id);
    } catch (err) {
      if (err instanceof SecurityValidationError) {
        return c.text(err.message, 400);
      }
      return c.text("读取工作流失败", 500);
    }

    if (!rec) {
      return c.text(`工作流 [${id}] 不存在或已被清理`, 404);
    }

    const normalizedNodes = normalizeNodes(rec.nodes);
    const dagPlan = buildDagPlan(normalizedNodes);
    rec.nodes = dagPlan.nodes;

    const agentRoster = resolveAgentRoster(rec.agentSnapshot || null);
    return c.html(renderWorkflowPage(rec, dagPlan, agentRoster));
  });

  // 4. 审批与执行提交端点 (同时支持 /workflow/:id/execute 和 /workflow/:id/approve)
  const handleApprove = async (c) => {
    let id = c.req.param("id");
    if (id === "latest") {
      const latest = readLatestRecord(ctx.dataDir);
      if (!latest || !latest.workflowId) {
        return c.json({ ok: false, error: "not_found", message: "未找到进行中的最新工作流" }, 404);
      }
      id = latest.workflowId;
    }

    try {
      validateWorkflowId(id);
    } catch (err) {
      return c.json({ ok: false, error: "invalid_id", message: err.message }, 400);
    }

    const rec = readWorkflowRecord(ctx.dataDir, id);
    if (!rec) {
      return c.json({ ok: false, error: "not_found", message: `工作流 [${id}] 不存在` }, 404);
    }

    // 历史迁移安全检查：旧版本残留的 delivery_unknown 记录不可自动再发
    if (rec.status === "delivery_unknown" || rec.locked === true) {
      return c.json({
        ok: false,
        error: "delivery_unknown_locked",
        message: "当前工作流属于旧版投递未决历史记录，已安全锁定不可自动重发，请重新生成画布规划。"
      }, 423);
    }

    // 解析请求体
    let body = {};
    if (typeof c.req.text === "function") {
      let rawText = "";
      try {
        rawText = await c.req.text();
      } catch {
        rawText = "";
      }
      if (rawText && rawText.trim().length > 0) {
        try {
          body = JSON.parse(rawText);
        } catch {
          return c.json({ ok: false, error: "invalid_json", message: "请求体不是合法的 JSON 格式" }, 400);
        }
      }
    } else if (typeof c.req.json === "function") {
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "invalid_json", message: "请求体不是合法的 JSON 格式" }, 400);
      }
    }

    // 获取专员白名单并合并合法动态添加的自定义专员
    const agentRoster = resolveAgentRoster(rec.agentSnapshot || null);
    if (Array.isArray(body?.customAgents)) {
      for (const ca of body.customAgents) {
        if (ca && typeof ca.id === "string" && isValidAgentId(ca.id)) {
          if (!agentRoster.agents.some((a) => a.id === ca.id)) {
            agentRoster.agents.push({
              id: ca.id,
              name: sanitizeString(ca.name, 64, ca.id),
              desc: sanitizeString(ca.desc, 200, "动态自定义专员"),
              tier: "custom",
              category: "custom",
              permission: "自定义专员职责"
            });
          }
        }
      }
    }

    const validAgentIds = new Set(agentRoster.agents.map((a) => a.id));
    const validNodeIds = new Set(rec.nodes.map((n) => n.id));

    // 复制节点列表供测试新分配
    const pendingNodes = JSON.parse(JSON.stringify(rec.nodes));

    const rawAssignments = body && typeof body.assignments === "object" ? body.assignments : null;
    if (rawAssignments !== null) {
      if (Array.isArray(rawAssignments)) {
        return c.json({ ok: false, error: "invalid_assignments_format", message: "assignments 必须为键值对象" }, 400);
      }

      // 白名单逐项强校验
      for (const [nodeId, agentId] of Object.entries(rawAssignments)) {
        if (!validNodeIds.has(nodeId)) {
          return c.json({
            ok: false,
            error: "unknown_assignment_node",
            message: `试图为不存在的节点 [${nodeId}] 分配专员`
          }, 400);
        }
        if (!validAgentIds.has(agentId)) {
          return c.json({
            ok: false,
            error: "invalid_agent_assignment",
            message: `专员标识 [${agentId}] 不在当前有效名录中`
          }, 400);
        }
        const targetNode = pendingNodes.find((n) => n.id === nodeId);
        if (targetNode) targetNode.assignedAgent = agentId;
      }
    }

    // 规范化并计算 DAG 完整方案
    const normalizedNodes = normalizeNodes(pendingNodes);
    for (const node of normalizedNodes) {
      if (!node.defaultAgent) {
        node.defaultAgent = "hanako-lite";
      }
    }
    const dagPlan = buildDagPlan(normalizedNodes);

    if (dagPlan.nodes.some(n => !validAgentIds.has(n.assignedAgent || n.defaultAgent || "hanako-lite"))) {
      return c.json({ ok: false, error: "invalid_agent_assignment", message: "存在未知执行人，请更换为当前有效专员。" }, 400);
    }

    // 全量计算当前方案的确定性指纹 (包含 title, description 及全量节点五要素契约)
    const calculatedHash = calculatePlanHash(id, dagPlan.nodes, rec.title, rec.description);

    // 核心安全约束：禁止客户端指定 submissionId！
    // submissionId 纯服务端完整长度 randomUUID 生成；重试沿用已有号；明确为公开去重 ID，非权限凭据
    let submissionId = (rec.submissionId && rec.planHash === calculatedHash)
      ? rec.submissionId
      : generateSubmissionId();

    // 核心约束：已批准方案不得静默改负责人！
    if (rec.approvalGranted === true) {
      if (rec.planHash && rec.planHash !== calculatedHash) {
        return c.json({
          ok: false,
          error: "plan_already_approved_conflict",
          message: `该工作流已获用户批准（指纹: ${rec.planHash}），禁止静默修改负责人或计划；如需调整请重新生成新画布。`
        }, 409);
      }

      // 相同指纹：幂等重试直接返回已有凭据
      return c.json({
        ok: true,
        workflowId: id,
        planHash: rec.planHash,
        submissionId: rec.submissionId,
        status: rec.status,
        dispatchText: rec.dispatchText || buildExecutionDispatchText(rec, dagPlan),
        idempotent: true,
        message: "方案已批准，返回已有可信凭据 (支持重新回传事件)"
      }, 200);
    }

    // 首次批准：持久化记录并计算 dispatchText
    rec.nodes = dagPlan.nodes;
    rec.dagPlan = {
      dispatchLane: dagPlan.dispatchLane,
      laneReason: dagPlan.laneReason,
      conflicts: dagPlan.conflicts,
      stats: dagPlan.stats
    };
    const dispatchText = buildExecutionDispatchText(rec, dagPlan);

    rec.approvalGranted = true;
    rec.approvedAt = new Date().toISOString();
    rec.status = "approved";
    rec.submitted = false;
    rec.executed = false;
    rec.planHash = calculatedHash;
    rec.submissionId = submissionId;
    rec.dispatchText = dispatchText;

    writeWorkflowRecord(ctx.dataDir, rec);

    ctx.log?.info?.(`[Workflow] 方案已通过认证UI接口批准并持久化: ${id}`, {
      planHash: calculatedHash,
      submissionId
    });

    return c.json({
      ok: true,
      workflowId: id,
      planHash: calculatedHash,
      submissionId,
      status: "approved",
      dispatchText,
      message: "方案已成功批准并持久化凭据 (submissionId为公开去重标识，非权限凭据)"
    }, 200);
  };

  app.post("/workflow/:id/execute", handleApprove);
  app.post("/workflow/:id/approve", handleApprove);
}
