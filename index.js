/**
 * Agent 工作流画布 (agent-workflow-canvas)
 * Hana App manifestVersion: 2 标准主入口
 */

import registerWorkflowRoutes from "./http/workflow.js";
import * as renderWorkflowTool from "./tools/render_workflow.js";

export const name = "agent-workflow-canvas";

export async function apply(ctx) {
  if (ctx.dataDir) {
    process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;
  }

  // 1. 注册工作流渲染工具 render_workflow
  if (ctx.tools && typeof ctx.tools.register === "function") {
    await ctx.tools.register({
      name: renderWorkflowTool.name,
      description: renderWorkflowTool.description,
      parameters: renderWorkflowTool.parameters,
      invocationStyle: "sdk_tool",
      sessionPermission: renderWorkflowTool.sessionPermission,
      execute: (args) => {
        // Only the host-stamped tool context is used; never persist callToken.
        const callContext = args?.context || {};
        return renderWorkflowTool.execute(args, {
          dataDir: ctx.dataDir,
          log: ctx.logger || ctx.log,
          bus: ctx.bus,
          sessionId: callContext.sessionId || null,
          sessionPath: callContext.sessionPath || null
        });
      }
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
