/**
 * 工作流看板路由服务 (V2 增强版)
 * 职责：
 * 1. 严格安全 ID 校验防路径穿越，支持 :id === "latest" 动态解析
 * 2. 独立固定路由 /workflow/:id 防止多卡片间串卡
 * 3. 补齐 sessionId 解析，双参数 session:send 保障宿主寻址可靠性
 * 4. 发送前落盘 pending，超时/未知异常 delivery_unknown 安全锁定防重复投递
 * 5. 深度契约检查：busResp ok===false 决不视作成功；busy与明确拒绝可恢复
 * 6. assignments 严格白名单校验 (节点必须存在，专员必须在有效名录中)
 * 7. 发送指令基于最终 dagPlan.nodes 全量要素 (层级/依赖/边界/验收五要素/复用等待契约)
 * 8. GET 端点保证旧数据在规范化后完整呈现 DAG 依赖与贝塞尔边线
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateWorkflowId, SecurityValidationError, sanitizeString } from "../lib/security.js";
import { buildDagPlan, normalizeNodes } from "../lib/dag.js";
import { resolveAgentRoster, isValidAgentId } from "../lib/agents.js";
import { renderWorkflowPage } from "../lib/theme.js";
import { resolveSessionIdFromPath } from "../lib/session_resolver.js";

// 内存级并发提交互斥锁
const pendingSubmissions = new Set();

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

export function writeWorkflowRecord(dataDir, rec) {
  validateWorkflowId(rec.id);
  const dir = join(dataDir, "workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2), "utf-8");
}

/**
 * 组装发送给主会话与主 Agent 的精简调度契约文本
 * 基于经过分层与写冲突消解后的最终 dagPlan.nodes 全量呈现
 */
export function buildExecutionDispatchText(rec, dagPlan) {
  // 基于最终计算完的 dagPlan.nodes 进行遍历
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
    + `1. 评估与派发：施工前轻量确认目标、工具、权限、范围、依赖、共享资源与验收。粉哥hanako强制画布审批仅两类：岳主动要求分身，或重大复杂任务需规划（主控独立执行也适用）；岳岳在当前任务明确要求粉哥派发时或重大任务需规划时，必须先调用正式render_workflow展示目标、工作包、执行者、依赖、权限及验收，等待岳明确批准已展示方案后才派发/施工，所有默认派发、并发启动和批次恢复受此门禁约束。粉哥（Agent ID：hanako）排错必须实际派发至少一个子代理，推荐多角度并发多个，不固定要求两人，不能以问题简单免除派发，但命中门禁须批准后履行；搜索调研与项目了解按有效拆分收益。仅讨论或修改派发规则不触发当前启动子代理。两类之外按独立收益自主派发；其他Agent按其个人契约判断，不新增审批条件。\n`
    + `2. 画布与发令：画布生成、展示与投递均不证明实际派发或批准；粉哥命中两类情形须按规划→展示画布→岳明确批准已展示方案→派发/施工执行，首次要求派发、生成投递、推荐项及后台完成/回调均不等批准。批准前仅许主控形成方案必要且已授权的只读检查，严禁先派后补图、新建或续接受影响执行分身、抢先施工及通过工作流或后台绕行；已有相关任务要求在受影响边界前暂停并核验真实状态。画布不可用报告并停在审批边界，不以文字或选项卡替代。当前按钮提交只授权当前展示计划，不扩展后续任务范围；主控不得代替用户点击。已批准方案的工作包、负责人、重要依赖、范围或风险实质变化，更新画布重新等待批准；等价低风险细节自主处理。其他Agent按个人契约与正式发令协议。删除、外部状态修改、难以撤销风险与授权缺口仍独立确认。工具、权限受限如实说明，不伪造点击或派发。正交无冲突并行，依赖/共享写冲突串行，不因行数或工单长度单独拒绝，不凑人数。\n`
    + `3. 唯一负责人：一包一执行者，文件、配置、安装、构建、服务和端口均属共享状态；主控不重复派出包施工。接手前确认原执行者完成或停止且无继续写入的遗留任务再核查现场；pending不证失败，busy不得同包接管。\n`
    + `4. 会话复用与批次挂起：简单工单几句话，自包含目标/边界/验收，同包用真实threadId续接。粉哥在派发前完成必须亲自处理的独立准备，或将可委派的就绪包纳入当前依赖批次；本批派发后交回控制权，无关任务不捆绑成全局门槛。正式宿主已支持并验收时，先建批次再启动子任务、回执落盘后停止父回合、等待期间禁止自动模型调用，本批所有成功/失败/取消等终态且父回合已退出后合并结果恢复；单任务通知不得提前唤醒。画布和插件不提供此宿主能力，拟新增接口须正式目录可见，候选代码不证明生效。当前仅subagent/wait_for_tasks时先简短进度、启动本批、记录真实task_id，再独立登记等待，之后不主动工具、轮询、选项卡或保活输出，按平台要求最短收尾且不得称严格挂起。子代理只交付结果，不发送继续或ok go on驱动父会话；用户插话可接管，停止撤销自动恢复。完成/旧attempt/重启及去重由宿主核对，启动未确认不得盲目重派。恢复后核验稳定产物。\n`
    + `5. 分级审查原则：普通改动适用测试；认证、授权、目录边界、命令策略、自动执行触发变更默认独立复核。自测有价值但不替代复核，构建不替代行为验收；无代理或环境受限报告缺口/待测，不冒称通过，不擅自启用未充分验证的高风险变更，不一律转交用户。\n`
    + `6. 权限与隔离底线：以当前Agent有效规则和用户授权为准，计划按钮不扩大权限，子Agent只隔离上下文；执行者不顺手重构/新增依赖/扩大范围，关键歧义先取证或回报。\n`
    + `7. 验收交付：执行者回报状态、改动产物、验证证据、问题与假设；主控核查实际差异和适用测试。无新证据重复尝试停止，有诊断修复可继续，不固定次数。视觉按实际能力，审美由用户最终决定，用户看效果与回滚说明按需，不强制三段交付。`;
}

export default function registerWorkflowRoutes(app, ctx) {
  // 1. 最新看板路由 (防串卡，将规范化后的 dagPlan 注入供渲染)
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

    // 关键修复：旧 nodes 规范化后直接覆盖回 rec.nodes，确保依赖与边线在界面上正确呈现
    const normalizedNodes = normalizeNodes(rec.nodes);
    const dagPlan = buildDagPlan(normalizedNodes);
    rec.nodes = dagPlan.nodes;

    const agentRoster = resolveAgentRoster(rec.agentSnapshot || null);
    return c.html(renderWorkflowPage(rec, dagPlan, agentRoster));
  });

  // 2. 独立固定路由 /workflow/:id (严格防串卡与防路径穿越，支持 latest)
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

    // 关键修复：规范化旧节点数据并回填
    const normalizedNodes = normalizeNodes(rec.nodes);
    const dagPlan = buildDagPlan(normalizedNodes);
    rec.nodes = dagPlan.nodes;

    const agentRoster = resolveAgentRoster(rec.agentSnapshot || null);
    return c.html(renderWorkflowPage(rec, dagPlan, agentRoster));
  });

  // 3. 提交调度执行端点 (支持 :id === "latest" 动态解析)
  app.post("/workflow/:id/execute", async (c) => {
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

    // 状态判定：投递未决硬锁定 (防重复执行)
    if (rec.status === "delivery_unknown" || rec.locked === true) {
      return c.json({
        ok: false,
        error: "delivery_unknown_locked",
        message: "当前工作流处于投递未决锁定状态。消息可能已送达总线，为避免重复派发已冻结，请人工核实会话。"
      }, 423);
    }

    // 已成功提交
    if (rec.status === "submitted" || rec.submitted === true || rec.executed === true) {
      return c.json({
        ok: false,
        error: "already_submitted",
        message: "该工作流已确认提交至宿主总线执行，不可重复提交。"
      }, 400);
    }

    // 正在处理中 (磁盘或内存锁)
    if (rec.status === "pending" || pendingSubmissions.has(id)) {
      return c.json({
        ok: false,
        error: "submission_in_progress",
        message: "当前工作流正处于提交处理队列中，请勿重复点击。"
      }, 409);
    }

    // 内存加锁
    pendingSubmissions.add(id);

    try {
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
          } catch (err) {
            return c.json({ ok: false, error: "invalid_json", message: "请求体不是合法的 JSON 格式" }, 400);
          }
        }
      } else if (typeof c.req.json === "function") {
        try {
          body = await c.req.json();
        } catch (err) {
          // 若请求提供了非空但非法的 JSON，明确拒绝
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
          // 校验通过，赋给节点
          const targetNode = rec.nodes.find((n) => n.id === nodeId);
          if (targetNode) targetNode.assignedAgent = agentId;
        }
      }

      // 规范化并计算 DAG 完整方案
      const normalizedNodes = normalizeNodes(rec.nodes);
      for (const node of normalizedNodes) {
        if (!node.defaultAgent) {
          node.defaultAgent = "coder";
        }
      }
      const dagPlan = buildDagPlan(normalizedNodes);
      rec.nodes = dagPlan.nodes;
      if (rec.nodes.some(n => !validAgentIds.has(n.assignedAgent || n.defaultAgent || "coder"))) {
        return c.json({ ok: false, error: "invalid_agent_assignment", message: "存在未知执行人，请更换为当前有效专员。" }, 400);
      }

      // 动态补齐 sessionId 解析 (防止宿主在缺少 sessionId 时抛出 Session manifest resolution 异常)
      if (!rec.sessionId && rec.sessionPath) {
        try {
          const resolved = await resolveSessionIdFromPath(rec.sessionPath, ctx.dataDir, ctx.bus);
          if (resolved) {
            rec.sessionId = resolved;
          }
        } catch {
          // 容错降级
        }
      }

      // 关键修复：发送前状态落盘为 pending！
      rec.status = "pending";
      rec.submittedAt = new Date().toISOString();
      writeWorkflowRecord(ctx.dataDir, rec);

      if (ctx.bus?.request && (rec.sessionId || rec.sessionPath)) {
        const dispatchText = buildExecutionDispatchText(rec, dagPlan);
        const payload = {
          text: dispatchText,
          scope: "all"
        };
        // 关键修复：双参数传递保障宿主寻址可靠性
        if (rec.sessionId) payload.sessionId = rec.sessionId;
        if (rec.sessionPath) payload.sessionPath = rec.sessionPath;
        // Target comes from the host-stamped creation context, never request JSON.
        // No expired callToken is persisted or reused.

        ctx.log?.info?.(`[Workflow] 正在向宿主总线发送调度计划: ${id}`);

        let busResp = null;
        try {
          busResp = await ctx.bus.request("session:send", payload);
        } catch (err) {
          const errStr = String(err?.message || err);

          // 核心修复：精准区分「宿主权限/归属/参数明确拒绝」与「未知网络超时/传输中断」
          const isPermissionDenied =
            errStr.includes("is not authorized") ||
            errStr.includes("has not granted") ||
            err?.code === "PERMISSION_DENIED" ||
            err?.status === 403;
          const isOwnershipDenied =
            errStr.includes("does not belong to app") ||
            errStr.includes("scope must be");

          if (isPermissionDenied || isOwnershipDenied) {
            // 宿主明确拒绝门禁：消息未被排队或投递，安全回滚 pending 状态为 idle，允许用户授权后重试
            rec.status = "idle";
            rec.submitted = false;
            rec.locked = false;
            rec.lastError = errStr;
            writeWorkflowRecord(ctx.dataDir, rec);

            ctx.log?.warn?.(`[Workflow] 宿主总线权限/归属明确拒绝: ${id}`, errStr);
            return c.json({
              ok: false,
              error: isPermissionDenied ? "permission_denied" : "ownership_denied",
              message: `宿主明确拒绝发令: ${errStr}`
            }, 403);
          }

          // 超时或未知/网络传输异常：保守落盘锁定为 delivery_unknown，严禁重置为 idle，防重复发令
          rec.status = "delivery_unknown";
          rec.locked = true;
          rec.lastError = errStr;
          rec.lockedAt = new Date().toISOString();
          writeWorkflowRecord(ctx.dataDir, rec);

          ctx.log?.warn?.(`[Workflow] 宿主总线异常/超时，安全锁定为 delivery_unknown: ${id}`, errStr);
          return c.json({
            ok: false,
            error: "delivery_unknown",
            message: "宿主应答超时或状态未决。指令可能已送达总线，为避免重复派发已锁定状态，请在主会话核实。"
          }, 504);
        }

        // 宿主总线明确拒绝 (ok === false)
        if (busResp && busResp.ok === false) {
          const errMsg = busResp.error || "宿主会话总线返回 ok=false 明确拒绝";
          ctx.log?.warn?.(`[Workflow] 宿主总线明确拒绝: ${id}`, errMsg);

          // 明确拒绝可恢复：回滚 pending 状态为 idle
          rec.status = "idle";
          rec.submitted = false;
          rec.locked = false;
          rec.lastError = typeof errMsg === "object" ? JSON.stringify(errMsg) : errMsg;
          writeWorkflowRecord(ctx.dataDir, rec);

          return c.json({
            ok: false,
            error: "bus_rejected",
            message: `总线明确拒绝: ${rec.lastError}`
          }, 502);
        }

        // 严格化总线回执判断：宿主正式成功回执必须包含 accepted === true，严格对标宿主官方规范
        const isAccepted = Boolean(busResp && busResp.accepted === true);
        if (!isAccepted) {
          const errMsg = "宿主总线应答格式无效或未包含明确成功确认 (accepted !== true)";
          rec.status = "delivery_unknown";
          rec.locked = true;
          rec.lastError = errMsg;
          rec.lockedAt = new Date().toISOString();
          writeWorkflowRecord(ctx.dataDir, rec);

          ctx.log?.warn?.(`[Workflow] 宿主总线回执未明确确认 accepted，锁定为 delivery_unknown: ${id}`);
          return c.json({
            ok: false,
            error: "delivery_unknown",
            message: "宿主总线回执不明确，为防重复派发已安全锁定，请核实会话。"
          }, 502);
        }

        // 真实 bus 明确确认 (accepted === true / ok === true)，正式标记 submitted 并落盘
        rec.status = "submitted";
        rec.submitted = true;
        rec.executed = true;
        rec.locked = false;
        rec.deliveryStatus = "confirmed";
        rec.confirmedAt = new Date().toISOString();
        rec.busResponse = { status: "accepted", data: busResp };
        writeWorkflowRecord(ctx.dataDir, rec);

        ctx.log?.info?.(`[Workflow] 宿主总线确认接收调度计划: ${id}`);
        return c.json({ ok: true, id: rec.id, status: "submitted" });
      } else {
        rec.status = "idle";
        writeWorkflowRecord(ctx.dataDir, rec);
        return c.json({
          ok: false,
          error: "no_bus_or_session",
          message: "未检测到可用的宿主 Session 总线或会话标识，无法投递调度。"
        }, 503);
      }
    } catch (err) {
      // 捕获其余意外异常，保守锁定
      const uncertain = rec.status === "pending" || rec.status === "submitted";
      rec.status = uncertain ? "delivery_unknown" : "idle";
      rec.locked = uncertain;
      writeWorkflowRecord(ctx.dataDir, rec);
      ctx.log?.error?.(`[Workflow] 提交宿主总线异常: ${id}`, err?.message);
      return c.json({
        ok: false,
        error: uncertain ? "delivery_unknown" : "bus_dispatch_failed",
        message: `宿主总线投递异常: ${err?.message || "网络或会话异常"}`
      }, uncertain ? 504 : 502);
    } finally {
      pendingSubmissions.delete(id);
    }
  });
}
