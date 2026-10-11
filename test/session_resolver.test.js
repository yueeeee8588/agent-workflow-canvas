import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionIdFromPath, extractSessionIdFromDiskFile, isValidHostSessionId } from "../lib/session_resolver.js";
import registerWorkflowRoutes, { writeWorkflowRecord, readWorkflowRecord } from "../http/workflow.js";

test("session_resolver: isValidHostSessionId 严格校验 sess_ 前缀", () => {
  assert.equal(isValidHostSessionId("sess_123456"), true);
  assert.equal(isValidHostSessionId("sess_0mv2irhsa_a3d20e58"), true);
  assert.equal(isValidHostSessionId("01a125a8-bf9b-7c57-a798-245c0ebc9641"), false);
  assert.equal(isValidHostSessionId(""), false);
  assert.equal(isValidHostSessionId(null), false);
  assert.equal(isValidHostSessionId(undefined), false);
});

test("session_resolver: 已有非空且合法 sess_ sessionId 直接直通返回", async () => {
  const res = await resolveSessionIdFromPath("some/path.jsonl", null, null, "sess_existing_123");
  assert.equal(res, "sess_existing_123");
});

test("session_resolver: 裸 UUID 被忽略并不作为合法 sessionId 直通", async () => {
  const res = await resolveSessionIdFromPath("", null, null, "01a125a8-bf9b-7c57-a798-245c0ebc9641");
  assert.equal(res, null);
});

test("session_resolver: sessionPath 为空时安全返回 null", async () => {
  const res = await resolveSessionIdFromPath("", null, null, null);
  assert.equal(res, null);
});

test("session_resolver: 宿主原生总线 session:get 优先反查成功", async () => {
  const mockBus = {
    request: async (topic, payload) => {
      if (topic === "session:get") {
        assert.equal(payload.sessionPath, "mock/target.jsonl");
        return { session: { sessionId: "sess_bus_get_888" } };
      }
      return null;
    }
  };

  const res = await resolveSessionIdFromPath("mock/target.jsonl", null, mockBus);
  assert.equal(res, "sess_bus_get_888");
});

test("session_resolver: 裸 UUID 文件提取被安全拒绝并返回 null (防伪 ID 污染)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  try {
    const sessionUuid = "01a125a8-bf9b-7c57-a798-245c0ebc9641";
    const filePath = join(tempDir, `2026-10-10T12-00-00-000Z_${sessionUuid}.jsonl`);
    const firstLine = JSON.stringify({
      type: "session",
      version: 3,
      id: sessionUuid,
      timestamp: "2026-10-10T12:00:00.000Z"
    });
    writeFileSync(filePath, `${firstLine}\n{"type":"message","id":"m1"}\n`, "utf-8");

    const directExtracted = extractSessionIdFromDiskFile(filePath);
    assert.equal(directExtracted, null);

    const res = await resolveSessionIdFromPath(filePath, null, null);
    assert.equal(res, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_resolver: 文件首行包含合法的 sess_ ID 时能够正确提取", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "jsonl-sess-test-"));
  try {
    const validId = "sess_0mv2fixture_12345";
    const filePath = join(tempDir, `session_test.jsonl`);
    const firstLine = JSON.stringify({
      type: "session",
      sessionId: validId
    });
    writeFileSync(filePath, `${firstLine}\n`, "utf-8");

    const directExtracted = extractSessionIdFromDiskFile(filePath);
    assert.equal(directExtracted, validId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_resolver: bus session:list 命中目标路径时提取 sessionId", async () => {
  const targetPath = join(tmpdir(), "mock_sessions", "target.jsonl");
  const mockBus = {
    request: async (topic) => {
      if (topic === "session:list") {
        return {
          sessions: [
            { sessionId: "sess_other", path: join(tmpdir(), "mock_sessions", "other.jsonl") },
            { sessionId: "sess_matched_999", path: targetPath }
          ]
        };
      }
      return null;
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
  const mockSessionPath = join(tempDir, "agents", "mock", "session_no_uuid.txt");
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

test("Route: POST /workflow/:id/execute 支持 latest 动态解析且持久化批准凭证 (零 session bus 调用)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-route-latest-v24-"));
  try {
    const dataDir = join(tempDir, "data", "agent-workflow-canvas");
    mkdirSync(dataDir, { recursive: true });

    const rec = {
      id: "wf_test_latest",
      title: "最新工作流测试",
      nodes: [
        { id: "step1", tag: "P1", title: "任务1", task: "做测试", boundary: "无", outputs: "产物", acceptance: "通过", defaultAgent: "hanako-lite", dependsOn: [] }
      ],
      status: "idle",
      approvalGranted: false
    };
    writeWorkflowRecord(dataDir, rec);
    writeFileSync(join(dataDir, "workflows", "latest.json"), JSON.stringify({ workflowId: "wf_test_latest" }));

    let busCalled = false;
    const mockBus = {
      request: async () => {
        busCalled = true;
        return { ok: true };
      }
    };

    const routes = {};
    const mockApp = {
      get: (path, handler) => { routes[`GET ${path}`] = handler; },
      post: (path, handler) => { routes[`POST ${path}`] = handler; }
    };

    registerWorkflowRoutes(mockApp, { dataDir, bus: mockBus, log: {} });

    const mockCtx = {
      req: {
        param: (k) => (k === "id" ? "latest" : null),
        json: async () => ({}),
        text: async () => JSON.stringify({})
      },
      json: (data, code = 200) => ({ data, code }),
      text: (t, code = 200) => ({ text: t, code })
    };

    const resp = await routes["POST /workflow/:id/execute"](mockCtx);
    assert.equal(resp.data.ok, true);
    assert.equal(resp.data.status, "approved");
    assert.ok(resp.data.planHash);
    assert.ok(resp.data.submissionId);
    assert.equal(busCalled, false, "快捷卡片架构下绝不调用 session bus");

    const saved = readWorkflowRecord(dataDir, "wf_test_latest");
    assert.equal(saved.approvalGranted, true);
    assert.equal(saved.status, "approved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_resolver: 端到端真实历史会话文件反查合法 sess_ ID", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-resolve-fixture-"));
  try {
    const sessionDir = join(tempDir, "agents", "mock", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "fixture_session.jsonl");
    const expectedSessionId = "sess_fixture_test_888";
    writeFileSync(sessionFile, JSON.stringify({ sessionId: expectedSessionId, content: "test" }) + "\n");

    const resolved = await resolveSessionIdFromPath(sessionFile);
    assert.equal(resolved, expectedSessionId);
    assert.equal(isValidHostSessionId(resolved), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_resolver: 各种路径格式（正斜杠、反斜杠、大写、小写）的鲁棒性反查", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-case-fixture-"));
  try {
    const sessionDir = join(tempDir, "agents", "mock", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "fixture_session.jsonl");
    const expectedSessionId = "sess_fixture_robust_999";
    writeFileSync(sessionFile, JSON.stringify({ sessionId: expectedSessionId, content: "test" }) + "\n");

    const slashPath = sessionFile.replace(/\\/g, "/");
    const upperPath = sessionFile.toUpperCase();

    const resSlash = await resolveSessionIdFromPath(slashPath);
    const resUpper = await resolveSessionIdFromPath(upperPath);

    assert.equal(resSlash, expectedSessionId);
    assert.equal(resUpper, expectedSessionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
