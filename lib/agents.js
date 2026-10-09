/**
 * 角色分工与全景 Agents 名录解析引擎 (通用开源版)
 * 涵盖：标准工程角色名录、本地安全只读探测、分组分类聚合、动态自定义专员注入与安全校验。
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
  core: "核心协同团队 (Core Team)",
  engineering: "工程落地与运维 (Engineering & Ops)",
  specialist: "专业战术攻坚 (Specialist & Tactics)",
  thinking: "深度分析与推演 (Analysis & Deduction)",
  custom: "本地与自定义专员 (Local & Custom)"
};

/**
 * 通用标准研发工程角色名录 (不依赖任何特定个人配置)
 */
export const BUILTIN_AGENTS = [
  // 核心协同团队
  {
    id: "lead",
    name: "主控编排 (lead / orchestrator)",
    desc: "会话主控 · 规划统筹/边界把关/全链路调度",
    tier: "lead",
    category: "core",
    permission: "主控编排职责"
  },
  {
    id: "architect",
    name: "系统架构 (architect)",
    desc: "系统设计 · 方案推演/技术选型/接口抽象",
    tier: "core",
    category: "core",
    permission: "架构推演职责"
  },
  {
    id: "coder",
    name: "全栈开发 (coder)",
    desc: "主力开发 · 功能实现/模块编码/单元测试",
    tier: "core",
    category: "core",
    permission: "代码编写职责"
  },
  {
    id: "reviewer",
    name: "代码审查 (reviewer)",
    desc: "质量门禁 · 代码审查/安全核验/规约复核",
    tier: "core",
    category: "core",
    permission: "审查核验职责"
  },

  // 工程落地与运维
  {
    id: "devops",
    name: "运维专员 (devops)",
    desc: "环境部署 · 服务运维/网络配置/脚本自动化",
    tier: "specialist",
    category: "engineering",
    permission: "运维部署职责"
  },
  {
    id: "browser",
    name: "网页执行官 (browser)",
    desc: "网页检索 · 自动化抓取/检索取证/端到端验证",
    tier: "specialist",
    category: "engineering",
    permission: "网页检索职责"
  },
  {
    id: "ui-designer",
    name: "前端工匠 (ui-designer)",
    desc: "界面交互 · 组件设计/视觉排版/交互动效",
    tier: "specialist",
    category: "engineering",
    permission: "界面设计职责"
  },

  // 深度分析与专项
  {
    id: "analyst",
    name: "综合分析 (analyst)",
    desc: "综合探究 · 数据分析/逻辑推演/报告起草",
    tier: "specialist",
    category: "thinking",
    permission: "综合分析职责"
  },
  {
    id: "domain-specialist",
    name: "领域专家 (domain-specialist)",
    desc: "专项攻坚 · 领域业务/专业文献/攻坚咨询",
    tier: "specialist",
    category: "specialist",
    permission: "专项分析职责"
  }
];

// 历史别名兼容导出
export const BUILTIN_AGENTS_5_0 = BUILTIN_AGENTS;

/**
 * 安全只读从本地环境探测真实安装的 Agents 目录 (只读读取 ~/.hanako/agents)
 * 仅提取公开名称与基本配置，不深入读取私密 identity.md 正文
 */
export function discoverLocalAgents() {
  try {
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

      // 仅安全解析 config.yaml 提取显示名称
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

      // 与标准内置名录匹配或作为本地专员注入
      const matchedBuiltin = BUILTIN_AGENTS.find((b) => b.id === aid);
      discovered.push({
        id: aid,
        name: matchedBuiltin?.name || `${displayName} (${aid})`,
        desc: matchedBuiltin?.desc || "本地环境专员",
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
 * 汇聚策略：外部快照优先；若无快照则合并本地真实探测与标准工程角色
 */
export function resolveAgentRoster(externalAgents = null) {
  // 1. 外部传入快照优先 (如从外部显式传入的专员列表)
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

    if (list.length > 0) return { source: "snapshot", label: "会话专员快照", agents: list };
  }

  // 2. 本地真实探测与标准工程角色聚合
  const localAgents = discoverLocalAgents();
  const baseMap = new Map();

  // 首先装入标准通用角色
  for (const b of BUILTIN_AGENTS) {
    baseMap.set(b.id, { ...b });
  }

  // 覆盖/合并本地真实探测到的专员
  if (localAgents && localAgents.length > 0) {
    for (const la of localAgents) {
      baseMap.set(la.id, { ...la });
    }
  }

  const isLocal = Boolean(localAgents && localAgents.length > 0);
  return {
    source: isLocal ? "local_hybrid" : "builtin_default",
    label: isLocal ? "本地环境与通用角色" : "标准通用工程角色",
    agents: Array.from(baseMap.values())
  };
}
