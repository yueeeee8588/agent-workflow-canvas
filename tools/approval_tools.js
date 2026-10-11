/**
 * 审批凭据读取与核销模型工具 (V2.4.0)
 * 提供:
 * 1. get_approved_workflow: 读可信后端持久化的批准全量方案及恢复状态，校验 id/hash，绝不盲信客户端 payload
 * 2. consume_workflow_approval: 原子核销已批准凭据 (标记为 claimed/consumed，非 dispatched/executed)；
 *    严格校验 submissionId/planHash；重复调用返回 duplicate 标识与已有 receipt；
 *    本插件无法杜绝外部或下游模型崩溃后的非幂等重发，重试时应结合已有 receipt 与真实任务 taskId 综合核验。
 */

import { getApprovedWorkflowRecord, consumeApprovedWorkflowRecord } from "../lib/approval_gate.js";
import { validateWorkflowId } from "../lib/security.js";

export const getApprovedWorkflowTool = {
  name: "get_approved_workflow",
  description: "读取可信后端已持久化批准的工作流全量方案及当前核销恢复状态。只能返回真实服务端记录，不信任前端或事件 payload 未经验证的声明；若工作流未获批准或方案指纹不匹配则安全拒绝。批准仅代表用户确认已展示计划，不扩大模型既有工具或操作权限。",
  parameters: {
    type: "object",
    properties: {
      workflowId: {
        type: "string",
        description: "待读取的工作流唯一标识符 (例如: wf_xxx)"
      },
      planHash: {
        type: "string",
        description: "可选：期望核对的方案指纹 (32位十六进制哈希)"
      }
    },
    required: ["workflowId"]
  },
  sessionPermission: {
    kind: "plugin_read",
    describeSideEffect: () => ({
      kind: "plugin_read",
      summary: "Read trusted workflow approval records from backend storage.",
      ruleId: "plugin-read-workflow-approval"
    })
  },
  execute: async (input, ctx = {}) => {
    const dataDir = ctx.dataDir || process.env.HANAKO_PLUGIN_DATA;
    if (!dataDir) {
      throw new Error("缺少插件数据存储路径 (dataDir)");
    }
    const workflowId = String(input?.workflowId || "").trim();
    validateWorkflowId(workflowId);
    const expectedHash = input?.planHash ? String(input.planHash).trim() : null;

    // 仅从 hostContext 提取宿主审计元数据，不信任 input 里的 context
    const hostAudit = {
      agentId: ctx.hostContext?.agentId || null,
      sessionId: ctx.hostContext?.sessionId || ctx.sessionId || null
    };

    const result = getApprovedWorkflowRecord(dataDir, workflowId, expectedHash, hostAudit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      details: result
    };
  }
};

export const consumeWorkflowApprovalTool = {
  name: "consume_workflow_approval",
  description: "原子核销已批准的工作流凭据（仅标记为 claimed/consumed，不代表已执行或派发）。严格核对 workflowId、planHash 与 submissionId，重复调用时返回 duplicate 标志及已有核销收据。此操作不扩大权限；若模型在领取后崩溃，下游重复重试应结合 receipt 与实际任务执行状态人工核对，不承诺分布式 exactly-once。",
  parameters: {
    type: "object",
    properties: {
      workflowId: {
        type: "string",
        description: "工作流唯一标识符"
      },
      planHash: {
        type: "string",
        description: "由用户批准锁定的确定性方案指纹 (32位十六进制哈希)"
      },
      submissionId: {
        type: "string",
        description: "提交凭证唯一标识符 (形如 sub_xxx，公开去重 ID)"
      }
    },
    required: ["workflowId", "planHash", "submissionId"]
  },
  sessionPermission: {
    kind: "plugin_output",
    describeSideEffect: () => ({
      kind: "plugin_output",
      summary: "Claim and mark a workflow approval record as consumed.",
      ruleId: "plugin-consume-workflow-approval"
    })
  },
  execute: async (input, ctx = {}) => {
    const dataDir = ctx.dataDir || process.env.HANAKO_PLUGIN_DATA;
    if (!dataDir) {
      throw new Error("缺少插件数据存储路径 (dataDir)");
    }
    const workflowId = String(input?.workflowId || "").trim();
    const planHash = String(input?.planHash || "").trim();
    const submissionId = String(input?.submissionId || "").trim();

    validateWorkflowId(workflowId);

    const hostAudit = {
      agentId: ctx.hostContext?.agentId || null,
      sessionId: ctx.hostContext?.sessionId || ctx.sessionId || null
    };

    const result = consumeApprovedWorkflowRecord(dataDir, workflowId, planHash, submissionId, hostAudit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      details: result
    };
  }
};
