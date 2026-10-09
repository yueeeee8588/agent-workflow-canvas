/**
 * 安全校验与边界防护模块
 * 防止路径穿越、超长输入缓冲区溢出与 HTML 注入
 */

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class SecurityValidationError extends Error {
  constructor(message, code = "SECURITY_VALIDATION_FAILED") {
    super(message);
    this.name = "SecurityValidationError";
    this.code = code;
  }
}

/**
 * 校验 Node ID，强制安全正则，防 </script> 注入与 DOM 属性穿透
 */
export function validateNodeId(id) {
  if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
    throw new SecurityValidationError(
      `非法的节点 ID: "${id}"。仅允许 1-64 位英文字母、数字、下划线及减号，严禁包含 HTML 标签或特殊字符。`,
      "INVALID_NODE_ID"
    );
  }
  return id;
}

/**
 * 安全序列化为内联 script JSON，防止 </script> 闭合标签 XSS 注入与特殊字符截断
 */
export function serializeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}


/**
 * 校验 Workflow ID，防止路径穿越 (如 ../, ..\\ 等)
 */
export function validateWorkflowId(id) {
  if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
    throw new SecurityValidationError(
      `非法的工作流标识: "${id}"。仅允许 1-64 位英文字母、数字、下划线及减号，禁止路径穿越。`,
      "INVALID_WORKFLOW_ID"
    );
  }
  return id;
}

/**
 * 安全过滤并限制字符串长度
 */
export function sanitizeString(val, maxLen = 500, fallback = "") {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  if (!str) return fallback;
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/**
 * HTML 特殊字符转义，防御 XSS
 */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 校验 render_workflow 输入边界
 */
export function validateWorkflowInput(input) {
  if (!input || typeof input !== "object") {
    throw new SecurityValidationError("输入必须为合法的配置对象", "INVALID_INPUT_ROOT");
  }

  const title = sanitizeString(input.title, 120, "项目协同工作流");
  const description = sanitizeString(input.description, 1000, "");

  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new SecurityValidationError("工作流必须至少包含 1 个有效节点", "NODES_EMPTY");
  }

  if (input.nodes.length > 64) {
    throw new SecurityValidationError("单画布节点数量超限 (最多允许 64 个节点)", "NODES_OVERFLOW");
  }

  return { title, description, rawNodes: input.nodes };
}
