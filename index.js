/**
 * Agent 工作流画布 (agent-workflow-canvas)
 * Hana App manifestVersion: 2 标准主入口
 */

import registerWorkflowRoutes from "./http/workflow.js";
import * as renderWorkflowTool from "./tools/render_workflow.js";

export const name = "agent-workflow-canvas";

export async function apply(ctx) {
  // 1. 注册工作流渲染工具 render_workflow
  if (ctx.tools && typeof ctx.tools.register === "function") {
    ctx.tools.register({
      name: renderWorkflowTool.name,
      description: renderWorkflowTool.description,
      parameters: renderWorkflowTool.parameters,
      sessionPermission: renderWorkflowTool.sessionPermission,
      execute: (args, invocationCtx) => renderWorkflowTool.execute(args, invocationCtx ? { ...ctx, ...invocationCtx } : ctx)
    });
  }

  // 2. 注册工作流 Webview / API 路由 (通过回调函数注入真正的 Hono/Express app 实例)
  if (ctx.routes && typeof ctx.routes.register === "function") {
    await ctx.routes.register((app) => {
      registerWorkflowRoutes(app, ctx);
    });
  }
}

export default apply;
