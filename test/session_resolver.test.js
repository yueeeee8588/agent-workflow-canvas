import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionIdFromPath } from "../lib/session_resolver.js";
import registerWorkflowRoutes, { writeWorkflowRecord } from "../http/workflow.js";

test("session_resolver: 已有非空 sessionId 直接直通返回", async () => {
  const res = await resolveSessionIdFromPath("some/path.jsonl", null, null, "sess_existing_123");
  assert.equal(res, "sess_existing_123");
});

test("session_resolver: sessionPath 为空时安全返回 null", async () => {
  const res = await resolveSessionIdFromPath("", null, null, null);
  assert.equal(res, null);
});

test("session_resolver: bus session:list 命中目标路径时提取 sessionId", async () => {
  const targetPath = join("C:", "mock", "sessions", "target.jsonl");
  const mockBus = {
    request: async (topic, payload) => {
      assert.equal(topic, "session:list");
      return {
        sessions: [
          { sessionId: "sess_other", path: join("C:", "mock", "sessions", "other.jsonl") },
          { sessionId: "sess_matched_999", path: targetPath }
        ]
      };
    }
  };

  const res = await resolveSessionIdFromPath(targetPath, null, mockBus);
  assert.equal(res, "sess_matched_999");
});

test("session_resolver: 本地 SQLite session-manifest.db 精准查询", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "db-test-"));
  const dbPath = join(tempDir, "session-manifest.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_manifests (
      session_id TEXT PRIMARY KEY,
      current_locator_path TEXT
    );
  `);
  const stmt = db.prepare("INSERT INTO session_manifests (session_id, current_locator_path) VALUES (?, ?)");
  const mockSessionPath = join(tempDir, "agents", "hanako", "session.jsonl");
  stmt.run("sess_sqlite_abc", mockSessionPath);
  db.close();

  try {
    const dataDir = join(tempDir, "data", "agent-workflow-canvas");
    mkdirSync(dataDir, { recursive: true });

    const res = await resolveSessionIdFromPath(mockSessionPath, dataDir, null);
    assert.equal(res, "sess_sqlite_abc");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_resolver: 真实宿主 session-manifest.db 寻址当前会话", async () => {
  const realDbPath = "C:\\Users\\asus\\.hanako\\session-manifest.db";
  if (existsSync(realDbPath)) {
    const realSessionPath = "C:\\Users\\asus\\.hanako\\agents\\hanako\\sessions\\2026-10-10T07-17-49-799Z_01a124ac-d867-7d3d-b973-8cec5fd755e5.jsonl";
    const res = await resolveSessionIdFromPath(realSessionPath, "C:\\Users\\asus\\.hanako\\data\\agent-workflow-canvas", null);
    assert.equal(res, "sess_0mv22b1xi_2bea5672c21141eb1365");
  }
});

test("Route: POST /workflow/:id/execute 支持 latest 且自动补齐 sessionId 并下发双参数", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-route-latest-"));
  try {
    const rec = {
      id: "wf_test_latest",
      title: "最新工作流测试",
      nodes: [
        { id: "step1", tag: "P1", title: "任务1", task: "做测试", boundary: "无", outputs: "产物", acceptance: "通过", defaultAgent: "hanako-lite", dependsOn: [] }
      ],
      sessionPath: "C:\\Users\\asus\\.hanako\\agents\\hanako\\sessions\\2026-10-10T07-17-49-799Z_01a124ac-d867-7d3d-b973-8cec5fd755e5.jsonl",
      sessionId: null,
      status: "idle"
    };
    writeWorkflowRecord(tempDir, rec);
    writeFileSync(join(tempDir, "workflows", "latest.json"), JSON.stringify({ workflowId: "wf_test_latest" }));

    let sentPayload = null;
    const mockBus = {
      request: async (topic, payload) => {
        if (topic === "session:send") {
          sentPayload = payload;
          return { accepted: true, ok: true };
        }
        return null;
      }
    };

    // 构造模拟路由 app
    const routes = {};
    const mockApp = {
      get: (path, handler) => { routes[`GET ${path}`] = handler; },
      post: (path, handler) => { routes[`POST ${path}`] = handler; }
    };

    registerWorkflowRoutes(mockApp, { dataDir: tempDir, bus: mockBus, log: {} });

    // 测试 latest 执行
    const mockCtx = {
      req: {
        param: (k) => (k === "id" ? "latest" : null),
        json: async () => ({})
      },
      json: (data, code = 200) => ({ data, code }),
      text: (t, code = 200) => ({ text: t, code })
    };

    const resp = await routes["POST /workflow/:id/execute"](mockCtx);
    assert.equal(resp.data.ok, true);
    assert.equal(resp.data.status, "submitted");

    // 验证 payload 同时包含 sessionId 和 sessionPath
    assert.ok(sentPayload);
    assert.equal(sentPayload.sessionId, "sess_0mv22b1xi_2bea5672c21141eb1365");
    assert.equal(sentPayload.sessionPath, rec.sessionPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
