/**
 * Agent 工作流画布 (agent-workflow-canvas)
 * Hana App manifestVersion: 2 标准主入口 (V2.4.0)
 * 采用快捷回复卡片回传架构：
 * 1. 生成卡片立即返回；
 * 2. 移除会话级 tools/pre-execute 黑名单锁（用户明确要求不锁会话）；
 * 3. 暴露 get_approved_workflow 与 consume_workflow_approval 模型工具；
 * 4. 经过认证 UI API 持久化方案审批凭据并由宿主回传事件。
 */

import registerWorkflowRoutes from "./http/workflow.js";
import * as renderWorkflowTool from "./tools/render_workflow.js";
import { getApprovedWorkflowTool, consumeWorkflowApprovalTool } from "./tools/approval_tools.js";

export const name = "agent-workflow-canvas";

export async function apply(ctx) {
  if (ctx.dataDir) {
    process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;
  }

  // 1. 注册工作流模型工具
  if (ctx.tools && typeof ctx.tools.register === "function") {
    // 1.1 render_workflow 工具 (生成卡片立即返回)
    await ctx.tools.register({
      name: renderWorkflowTool.name,
      description: renderWorkflowTool.description,
      parameters: renderWorkflowTool.parameters,
      invocationStyle: "sdk_tool",
      sessionPermission: renderWorkflowTool.sessionPermission,
      execute: (args, hostContext = {}) => {
        const sessionId =
          (typeof hostContext?.sessionId === "string" && hostContext.sessionId.trim()) ||
          (typeof hostContext?.sessionRef?.sessionId === "string" && hostContext.sessionRef.sessionId.trim()) ||
          (typeof hostContext?.sessionContext?.sessionId === "string" && hostContext.sessionContext.sessionId.trim()) ||
          (typeof hostContext?.runtimeCtx?.sessionId === "string" && hostContext.runtimeCtx.sessionId.trim()) ||
          (typeof args?.context?.sessionId === "string" && args.context.sessionId.trim()) ||
          (typeof args?.sessionId === "string" && args.sessionId.trim()) ||
          null;

        const sessionPath =
          (typeof hostContext?.sessionPath === "string" && hostContext.sessionPath.trim()) ||
          (typeof hostContext?.sessionRef?.sessionPath === "string" && hostContext.sessionRef.sessionPath.trim()) ||
          (typeof hostContext?.sessionContext?.sessionPath === "string" && hostContext.sessionContext.sessionPath.trim()) ||
          (typeof hostContext?.runtimeCtx?.sessionPath === "string" && hostContext.runtimeCtx.sessionPath.trim()) ||
          (typeof args?.context?.sessionPath === "string" && args.context.sessionPath.trim()) ||
          (typeof args?.sessionPath === "string" && args.sessionPath.trim()) ||
          null;

        return renderWorkflowTool.execute(args, {
          dataDir: ctx.dataDir,
          log: ctx.logger || ctx.log,
          bus: ctx.bus,
          sessionId,
          sessionPath,
          sessionRef: hostContext?.sessionRef || args?.context?.sessionRef || null
        });
      }
    });

    // 1.2 get_approved_workflow 工具 (读可信后端批准全量方案)
    await ctx.tools.register({
      name: getApprovedWorkflowTool.name,
      description: getApprovedWorkflowTool.description,
      parameters: getApprovedWorkflowTool.parameters,
      invocationStyle: "sdk_tool",
      sessionPermission: getApprovedWorkflowTool.sessionPermission,
      execute: (args, hostContext = {}) => {
        return getApprovedWorkflowTool.execute(args, {
          dataDir: ctx.dataDir,
          log: ctx.logger || ctx.log,
          bus: ctx.bus,
          hostContext
        });
      }
    });

    // 1.3 consume_workflow_approval 工具 (原子消费已批准凭据，防重复派发)
    await ctx.tools.register({
      name: consumeWorkflowApprovalTool.name,
      description: consumeWorkflowApprovalTool.description,
      parameters: consumeWorkflowApprovalTool.parameters,
      invocationStyle: "sdk_tool",
      sessionPermission: consumeWorkflowApprovalTool.sessionPermission,
      execute: (args, hostContext = {}) => {
        return consumeWorkflowApprovalTool.execute(args, {
          dataDir: ctx.dataDir,
          log: ctx.logger || ctx.log,
          bus: ctx.bus,
          hostContext
        });
      }
    });
  }

  // 2. 注册工作流 Webview / API 路由
  if (ctx.routes && typeof ctx.routes.register === "function") {
    await ctx.routes.register((app) => {
      registerWorkflowRoutes(app, ctx);
    });
  }

  (ctx.logger || ctx.log)?.info?.('[agent-workflow-canvas] V2.4.0 快捷回复卡片架构初始化完成 (无会话黑名单锁)');
}

export default apply;
