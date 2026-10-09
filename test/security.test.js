import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkflowId,
  validateNodeId,
  serializeJsonForScript,
  SecurityValidationError,
  sanitizeString,
  escapeHtml,
  validateWorkflowInput
} from "../lib/security.js";

test("Security - Node ID 严格安全正则防注入", () => {
  const illegalNodeIds = [
    "</script>",
    "<script>alert(1)</script>",
    "node.with.dot",
    "node/slash",
    "node\\backslash",
    "node with space",
    "node#hash",
    "node!excl",
    "",
    null,
    undefined,
    "a".repeat(65)
  ];

  for (const nid of illegalNodeIds) {
    assert.throws(
      () => validateNodeId(nid),
      (err) => {
        assert(err instanceof SecurityValidationError);
        assert.equal(err.code, "INVALID_NODE_ID");
        return true;
      },
      `应该拒绝非法节点 ID: ${nid}`
    );
  }

  assert.equal(validateNodeId("step_1"), "step_1");
  assert.equal(validateNodeId("worker-2a"), "worker-2a");
  assert.equal(validateNodeId("WP01"), "WP01");
});

test("Security - serializeJsonForScript 统一转义内联特殊字符", () => {
  const payload = {
    xss: "</script><script>alert('evil')</script>",
    entity: "A & B > C < D",
    u2028: "line\u2028sep",
    u2029: "para\u2029sep"
  };

  const serialized = serializeJsonForScript(payload);
  assert(!serialized.includes("<"));
  assert(!serialized.includes(">"));
  assert(!serialized.includes("&"));
  assert(serialized.includes("\\u003c/script\\u003e"));
  assert(serialized.includes("\\u0026"));
  assert(serialized.includes("\\u2028"));
  assert(serialized.includes("\\u2029"));
});


test("Security - 路径穿越与非法 ID 阻断", () => {
  const illegalIds = [
    "../evil",
    "..\\evil",
    "/root/hack",
    "wf/123",
    "../../etc/passwd",
    "foo*bar",
    "foo$bar",
    "",
    null,
    undefined,
    "   ",
    "a".repeat(65) // 超过64位
  ];

  for (const id of illegalIds) {
    assert.throws(
      () => validateWorkflowId(id),
      (err) => {
        assert(err instanceof SecurityValidationError);
        assert.equal(err.code, "INVALID_WORKFLOW_ID");
        return true;
      },
      `应该拒绝非法 ID: ${id}`
    );
  }

  // 合法 ID
  assert.equal(validateWorkflowId("wf_123_abc"), "wf_123_abc");
  assert.equal(validateWorkflowId("workflow-canvas-2026"), "workflow-canvas-2026");
});

test("Security - 字符串清洗与长度限制", () => {
  assert.equal(sanitizeString(null, 10, "default"), "default");
  assert.equal(sanitizeString("   hello   ", 10), "hello");
  assert.equal(sanitizeString("abcdefghijk", 5), "abcde");
});

test("Security - HTML 实体转义防御 XSS", () => {
  const unsafe = `<script>alert("xss & 'danger'")</script>`;
  const safe = escapeHtml(unsafe);
  assert(!safe.includes("<script>"));
  assert(safe.includes("&lt;script&gt;"));
  assert(safe.includes("&amp;"));
  assert(safe.includes("&quot;"));
  assert(safe.includes("&#39;"));
});

test("Security - 输入边界校验", () => {
  // 空节点
  assert.throws(
    () => validateWorkflowInput({ title: "ok", nodes: [] }),
    (err) => err.code === "NODES_EMPTY"
  );

  // 超过最大节点限制 (64)
  const tooManyNodes = Array.from({ length: 65 }, (_, i) => ({ id: `n_${i}` }));
  assert.throws(
    () => validateWorkflowInput({ title: "ok", nodes: tooManyNodes }),
    (err) => err.code === "NODES_OVERFLOW"
  );

  // 正常输入
  const valid = validateWorkflowInput({
    title: "  我的工作流  ",
    description: "说明文本",
    nodes: [{ id: "n1", title: "测试" }]
  });
  assert.equal(valid.title, "我的工作流");
  assert.equal(valid.rawNodes.length, 1);
});
