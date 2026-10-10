/**
 * 会话标识解析服务 (Session Resolver)
 * 职责：
 * 当宿主在 render_workflow 上下文中仅提供了 sessionPath 而缺失 sessionId 时，
 * 依次通过宿主总线 session:list 与宿主 session-manifest.db 数据库反查精准的 sessionId，
 * 解决宿主底层 legacySessionPath 无法寻址导致 Session manifest resolution requires sessionId 错误。
 */

import { DatabaseSync } from "node:sqlite";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * 根据 sessionPath 解析并提取宿主标准的 sessionId
 * @param {string} sessionPath - 宿主会话路径 (如 .jsonl 路径)
 * @param {string} [dataDir] - 插件数据目录
 * @param {object} [bus] - 宿主事件总线客户端
 * @param {string} [sessionId] - 若已有非空 sessionId 则优先直接返回
 * @returns {Promise<string|null>}
 */
export async function resolveSessionIdFromPath(sessionPath, dataDir = null, bus = null, sessionId = null) {
  // 1. 若已有非空 sessionId，直接返回
  if (sessionId && typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessionId.trim();
  }

  if (!sessionPath || typeof sessionPath !== "string" || sessionPath.trim().length === 0) {
    return null;
  }

  const cleanSessionPath = sessionPath.trim();

  // 2. 若提供了 bus?.request，先尝试 session:list 匹配 active 会话
  if (bus && typeof bus.request === "function") {
    try {
      const resp = await bus.request("session:list", { scope: "all", lifecycle: "active" });
      const sessions = Array.isArray(resp)
        ? resp
        : (Array.isArray(resp?.sessions) ? resp.sessions : []);

      const targetNorm = resolve(cleanSessionPath).toLowerCase();
      for (const s of sessions) {
        if (s?.path && resolve(s.path).toLowerCase() === targetNorm && s.sessionId) {
          return String(s.sessionId).trim();
        }
      }
    } catch {
      // 忽略总线权限或调用异常，平滑降级至本地 SQLite 数据库查询
    }
  }

  // 3. 兜底方案：使用 Node.js 内置 DatabaseSync 查询宿主 session-manifest.db
  try {
    let dbPath = null;

    // 优先检查宿主数据目录同级或上级的 session-manifest.db
    if (dataDir) {
      const candidateDataDb = resolve(join(dataDir, "..", "..", "session-manifest.db"));
      if (existsSync(candidateDataDb)) {
        dbPath = candidateDataDb;
      }
    }

    // 其次从 sessionPath 逐级向上查找 session-manifest.db
    if (!dbPath) {
      let curr = dirname(resolve(cleanSessionPath));
      while (curr && dirname(curr) !== curr) {
        const candDirect = join(curr, "session-manifest.db");
        if (existsSync(candDirect)) {
          dbPath = candDirect;
          break;
        }
        const candDotHanako = join(curr, ".hanako", "session-manifest.db");
        if (existsSync(candDotHanako)) {
          dbPath = candDotHanako;
          break;
        }
        curr = dirname(curr);
      }
    }

    if (dbPath && existsSync(dbPath)) {
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        const normPath = resolve(cleanSessionPath);
        const row = db.prepare(
          "SELECT session_id FROM session_manifests WHERE current_locator_path = ? OR LOWER(current_locator_path) = LOWER(?) LIMIT 1"
        ).get(normPath, normPath);

        if (row && row.session_id) {
          return String(row.session_id).trim();
        }
      } finally {
        if (db) {
          try {
            db.close();
          } catch {
            // 安全关闭句柄
          }
        }
      }
    }
  } catch {
    // 任何数据库或路径异常安全降级返回 null
  }

  return null;
}
