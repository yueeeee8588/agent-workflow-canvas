/**
 * 会话标识解析服务 (Session Resolver) - Node 22+ 原生 SQLite 零锁终审版
 * 职责：
 * 当宿主在 render_workflow 或发令上下文中仅提供了 sessionPath 而缺失 sessionId 时，
 * 依次通过宿主原生 session:get、Node 内置 node:sqlite 数据库精准反查、
 * 零锁纯文本文件首行、以及广播列表，100% 稳定反查宿主合法的 sess_... 标识。
 * 彻底消除宿主 1.0.11-beta 因只认 sessionPath 导致 legacySessionPath 寻址报错。
 */

import { DatabaseSync } from "node:sqlite";
import { resolve, dirname, join, basename } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * 校验是否为合法的宿主 Manifest Session ID
 * 宿主规范以 sess_ 开头，兼容测试 mock 标识，严禁 8-4-4-4-12 裸 UUID 混入
 */
export function isValidHostSessionId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  if (!s) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return false;
  }
  return s.startsWith("sess_") || s.startsWith("mock");
}

/**
 * 零锁快速文件提取：从 .jsonl 文件首行提取合法以 sess_ 开头的会话 ID
 * 严禁提取裸 UUID 冒充总线 Manifest ID
 */
export function extractSessionIdFromDiskFile(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return null;
  try {
    if (existsSync(sessionPath)) {
      const fd = readFileSync(sessionPath, { encoding: "utf-8", flag: "r" });
      const firstLine = fd.split("\n", 1)[0]?.trim();
      if (firstLine && firstLine.startsWith("{") && firstLine.endsWith("}")) {
        try {
          const parsed = JSON.parse(firstLine);
          if (parsed && typeof parsed.sessionId === "string" && isValidHostSessionId(parsed.sessionId)) {
            return parsed.sessionId.trim();
          }
          if (parsed && typeof parsed.id === "string" && isValidHostSessionId(parsed.id)) {
            return parsed.id.trim();
          }
        } catch {}
      }
    }
  } catch {}

  return null;
}

/**
 * 根据 sessionPath 解析并提取宿主标准的 sessionId
 * @param {string} sessionPath - 宿主会话路径 (如 .jsonl 路径)
 * @param {string} [dataDir] - 插件数据目录
 * @param {object} [bus] - 宿主事件总线客户端
 * @param {string} [sessionId] - 若已有合法的 sess_ sessionId 则优先直接返回
 * @returns {Promise<string|null>}
 */
export async function resolveSessionIdFromPath(sessionPath, dataDir = null, bus = null, sessionId = null) {
  // 1. 若已有合法的前缀标识，直接返回
  if (isValidHostSessionId(sessionId)) {
    return sessionId.trim();
  }

  if (!sessionPath || typeof sessionPath !== "string" || sessionPath.trim().length === 0) {
    return null;
  }

  const cleanSessionPath = sessionPath.trim();
  const targetBase = basename(cleanSessionPath).toLowerCase();

  // 2. 核心通道：若总线可用，优先调用宿主原生 session:get 接口获取官方 sessionId
  if (bus && typeof bus.request === "function") {
    try {
      const getResp = await bus.request("session:get", { sessionPath: cleanSessionPath });
      const foundId = getResp?.session?.sessionId || getResp?.sessionId;
      if (isValidHostSessionId(foundId)) {
        return foundId.trim();
      }
    } catch {}
  }

  // 3. 原生 SQLite 索引通道：使用 Node 内置 node:sqlite 查询 session-manifest.db
  try {
    let dbPath = null;
    if (dataDir) {
      const candidateDataDb = resolve(join(dataDir, "..", "..", "session-manifest.db"));
      if (existsSync(candidateDataDb)) dbPath = candidateDataDb;
    }
    if (!dbPath) {
      const candidateHomeDb = resolve(join(process.env.HANA_HOME || join(homedir(), ".hanako"), "session-manifest.db"));
      if (existsSync(candidateHomeDb)) dbPath = candidateHomeDb;
    }
    if (!dbPath) {
      let curr = dirname(resolve(cleanSessionPath));
      while (curr && dirname(curr) !== curr) {
        const candDirect = join(curr, "session-manifest.db");
        if (existsSync(candDirect)) { dbPath = candDirect; break; }
        const candDot = join(curr, ".hanako", "session-manifest.db");
        if (existsSync(candDot)) { dbPath = candDot; break; }
        curr = dirname(curr);
      }
    }

    if (dbPath && existsSync(dbPath)) {
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        const normPath = resolve(cleanSessionPath);
        const lowerPath = normPath.toLowerCase();

        // 核心反查：current_locator_key 存放路径小写形式
        let row = null;
        try {
          row = db.prepare(
            `SELECT session_id FROM session_manifests 
             WHERE current_locator_key = ? OR LOWER(current_locator_path) = ? 
             LIMIT 1`
          ).get(lowerPath, lowerPath);
        } catch {
          row = db.prepare(
            "SELECT session_id FROM session_manifests WHERE current_locator_path = ? OR LOWER(current_locator_path) = LOWER(?) LIMIT 1"
          ).get(normPath, normPath);
        }

        if (row && isValidHostSessionId(row.session_id)) {
          return String(row.session_id).trim();
        }
      } finally {
        if (db) {
          try { db.close(); } catch {}
        }
      }
    }
  } catch {}

  // 4. 零锁通道：从磁盘文件首行提取（仅在包含合法 sess_ 标识时采纳）
  const diskId = extractSessionIdFromDiskFile(cleanSessionPath);
  if (diskId && isValidHostSessionId(diskId)) {
    return diskId;
  }

  // 5. 广播通道：若总线可用，遍历会话列表匹配
  if (bus && typeof bus.request === "function") {
    try {
      const respAll = await bus.request("session:list", { scope: "all" });
      const allList = Array.isArray(respAll) ? respAll : (Array.isArray(respAll?.sessions) ? respAll.sessions : []);
      for (const s of allList) {
        const sPath = s?.path || s?.sessionPath || s?.filePath;
        if (sPath && basename(sPath).toLowerCase() === targetBase && isValidHostSessionId(s.sessionId)) {
          return String(s.sessionId).trim();
        }
      }
    } catch {}
  }

  return null;
}
