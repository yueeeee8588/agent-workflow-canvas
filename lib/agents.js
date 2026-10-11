/**
 * 协同 5.0 角色分工与全景 Agents 名录解析引擎 (V2.1 增强版)
 * 涵盖：全量官方 15+ 专员标准名录、本地只读深层探测、分组分类聚合、动态自定义专员注入与安全校验。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeString } from "./security.js";

/**
 * 有效 Agent ID 正则安全校验（仅允许字母、数字、下划线、短横线，长度 1-64）
 */
export const AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidAgentId(id) {
  if (!id || typeof id !== "string") return false;
  return AGENT_ID_REGEX.test(id.trim());
}

/**
 * 专员分类枚举与中文标签
 */
export const AGENT_CATEGORIES = {
  core: "核心协同主力 (Core Team)",
  engineering: "工程落地与运维检索 (Engineering & Ops)",
  domain: "专业学科与战术攻坚 (Specialist & Tactics)",
  thinking: "深度学术与哲学推演 (Philosophy & Deduction)",
  support: "心理共情与健康支持 (Empathy & Health)",
  custom: "动态扩展与自定义专员 (Custom Agents)"
};

/**
 * 经宿主环境核实的 15+ 全量有效专员标准名录
 */
export const BUILTIN_AGENTS_5_0 = [
  // 核心协同四大主力
  {
    id: "hanako-lite",
    name: "轻装粉哥 (hanako-lite)",
    desc: "主力施工 · 实现/调试/脚本编写/闭环测试",
    tier: "core",
    category: "core",
    permission: "工程落地建议职责 (受会话实际权限约束)"
  },
  {
    id: "hajimi",
    name: "哈基米 (hajimi)",
    desc: "独立审查 · 逻辑核对/风险把关/门禁验收",
    tier: "core",
    category: "core",
    permission: "审查核验建议职责 (只读建议)"
  },
  {
    id: "lange",
    name: "蓝哥 (lange)",
    desc: "架构攻坚 · 复杂架构/系统设计/疑难算法攻坚",
    tier: "core",
    category: "core",
    permission: "架构推演建议职责 (只读推演)"
  },
  {
    id: "hanako",
    name: "主会话专员 (hanako)",
    desc: "当前会话主控 · 意图推演与全流程总揽统筹",
    tier: "lead",
    category: "core",
    permission: "会话总揽职责 (受会话实际权限约束)"
  },

  // 工程落地与运维检索
  {
    id: "browser-agent",
    name: "网页执行官 (browser-agent)",
    desc: "网页自动化 · 浏览器深度交互/网络检索与数据采集",
    tier: "specialist",
    category: "engineering",
    permission: "网页与自动化检索职责"
  },
  {
    id: "laok",
    name: "老K (laok)",
    desc: "前端工匠 · 排版/动效/UI交互设计与SVG/Canvas",
    tier: "specialist",
    category: "engineering",
    permission: "界面与交互构建建议"
  },
  {
    id: "jiediange-93fdb2",
    name: "节点哥 (jiediange-93fdb2)",
    desc: "VPS运维 · 反代/网络排障与系统部署运维",
    tier: "specialist",
    category: "engineering",
    permission: "系统与网络排障建议"
  },
  {
    id: "jiediange",
    name: "节点哥 (jiediange)",
    desc: "VPS运维 · 兼容别名标识",
    tier: "specialist",
    category: "engineering",
    permission: "系统运维建议"
  },

  // 专业学科与战术攻坚
  {
    id: "akang-2",
    name: "阿康 (akang-2)",
    desc: "运动康复 · 运动解剖与生物力学分析/康评与物治",
    tier: "specialist",
    category: "domain",
    permission: "运动康复咨询建议"
  },
  {
    id: "xutao",
    name: "徐涛 (xutao)",
    desc: "考研政治 · 辩证唯物与知识切片类比/马原毛中特",
    tier: "specialist",
    category: "domain",
    permission: "理论切片教学建议"
  },
  {
    id: "kouzi",
    name: "骚扣 (kouzi)",
    desc: "深度推演 · 复杂战术谋划与推演/策略对比",
    tier: "specialist",
    category: "domain",
    permission: "战术策略推演建议"
  },

  // 深度学术与哲学推演
  {
    id: "mawang",
    name: "马王 (mawang)",
    desc: "深度思辨 · 哲学脉络与学术严谨论证/底层原理剖析",
    tier: "specialist",
    category: "thinking",
    permission: "哲学与学术论证建议"
  },
  {
    id: "qianwen",
    name: "千问 (qianwen)",
    desc: "综合素养 · 文学哲学与数理学术深度推演",
    tier: "specialist",
    category: "thinking",
    permission: "综合数理人文推演建议"
  },
  {
    id: "dafeiyu",
    name: "大肥鱼 (dafeiyu)",
    desc: "概念溯源 · 跨学科发散与知识脉络追溯",
    tier: "specialist",
    category: "thinking",
    permission: "跨学科概念溯源建议"
  },

  // 心理共情与人文支持
  {
    id: "green",
    name: "绿哥 (green)",
    desc: "心理洞察 · 共情支持/意图捕捉/医学健康辅助",
    tier: "specialist",
    category: "support",
    permission: "心理与健康分析建议"
  }
];

/**
 * 只读从本地环境探测 Agents 目录 (只读读取 ~/.hanako/agents)
 * 提取 config.yaml、identity.md 等元数据建立丰富展示信息
 */
export function discoverLocalAgents() {
  try {
    // 测试环境安全隔离：未显式开启探测时不读取宿主环境真实目录，确保自包含与 0 环境依赖
    if (process.env.NODE_ENV === "test" && !process.env.HANA_TEST_ALLOW_DISCOVERY) {
      return null;
    }
    const hanaHome = process.env.HANA_HOME || join(homedir(), ".hanako");
    const agentsDir = join(hanaHome, "agents");
    if (!existsSync(agentsDir)) return null;

    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const discovered = [];

    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name) continue;
      const aid = ent.name;
      if (!isValidAgentId(aid)) continue;

      let displayName = aid;
      let discoveredDesc = null;

      // 1. 尝试解析 config.yaml 提取名称
      try {
        const yamlPath = join(agentsDir, aid, "config.yaml");
        if (existsSync(yamlPath)) {
          const yaml = readFileSync(yamlPath, "utf-8");
          const mName = yaml.match(/^\s*name:\s*(.+)$/m);
          if (mName && mName[1]) {
            displayName = mName[1].trim().replace(/^["']|["']$/g, "").trim();
          }
        }
      } catch {
        /* 只读忽略 */
      }

      // 2. 尝试从 description.md 或 identity.md 提取第一段简短摘要
      try {
        for (const metaFile of ["description.md", "identity.md"]) {
          const mPath = join(agentsDir, aid, metaFile);
          if (existsSync(mPath)) {
            const rawContent = readFileSync(mPath, "utf-8");
            const firstLine = rawContent
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l.length > 5 && !l.startsWith("#"));
            if (firstLine) {
              discoveredDesc = sanitizeString(firstLine, 120);
              break;
            }
          }
        }
      } catch {
        /* 只读忽略 */
      }

      // 3. 与内置名录信息进行智能对齐与补充
      const matchedBuiltin = BUILTIN_AGENTS_5_0.find((b) => b.id === aid);
      discovered.push({
        id: aid,
        name: matchedBuiltin?.name || `${displayName} (${aid})`,
        desc: discoveredDesc || matchedBuiltin?.desc || "本地探测专员",
        tier: matchedBuiltin?.tier || "custom",
        category: matchedBuiltin?.category || "custom",
        permission: matchedBuiltin?.permission || "本地专员职责"
      });
    }

    return discovered.length > 0 ? discovered : null;
  } catch {
    return null;
  }
}

/**
 * 解析并规范化可用 Agent 阵容
 * 汇聚策略：外部快照 > 本地探测 + 内置名录超集并集去重（保证一个不少）
 */
export function resolveAgentRoster(externalAgents = null) {
  // 1. 外部传入快照优先 (如从 agent_manager list 快照传入)
  if (Array.isArray(externalAgents) && externalAgents.length > 0) {
    const list = externalAgents
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const id = sanitizeString(item.id, 64);
        if (!isValidAgentId(id)) return null;
        const name = sanitizeString(item.name, 64, id);
        const desc = sanitizeString(item.desc || item.description, 200, "专项代理");
        const permission = sanitizeString(item.permission, 100, "受控执行");
        const tier = item.tier ? sanitizeString(item.tier, 30) : "custom";
        const category = item.category ? sanitizeString(item.category, 30) : "custom";
        return { id, name, desc, tier, category, permission };
      })
      .filter(Boolean);

    if (list.length > 0) {
      return {
        agents: list,
        source: "external-snapshot",
        label: "调用端传入快照 (agent_manager)"
      };
    }
  }

  // 2. 本地只读文件系统探测与内置全景阵容并集聚合
  const localList = discoverLocalAgents() || [];
  const mergedMap = new Map();

  // 首先放入内置名录作为基底
  for (const b of BUILTIN_AGENTS_5_0) {
    mergedMap.set(b.id, { ...b });
  }

  // 用本地探测到的专员进行丰富与覆盖，且补充本地独有的专员
  for (const l of localList) {
    if (mergedMap.has(l.id)) {
      const existing = mergedMap.get(l.id);
      mergedMap.set(l.id, {
        ...existing,
        ...l,
        name: existing.name || l.name,
        desc: l.desc && l.desc !== "本地探测专员" ? l.desc : existing.desc
      });
    } else {
      mergedMap.set(l.id, l);
    }
  }

  const allAgents = Array.from(mergedMap.values());

  return {
    agents: allAgents,
    source: localList.length > 0 ? "local-discovery" : "builtin-all",
    label: `全景协同名录 (共 ${allAgents.length} 位专员)`
  };
}
