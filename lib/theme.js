/**
 * 纸墨风视觉主题与 SVG 真实 DAG 边线渲染器 (V2.1 增强版)
 * 规范：包含 36px 标题安全区、明暗宣纸水墨质感、贝塞尔曲线边线、全景分组专员选择与自定义专员动态注入
 */

import { escapeHtml, serializeJsonForScript } from "./security.js";
import { AGENT_CATEGORIES } from "./agents.js";
import { calculatePlanHash } from "./approval_gate.js";
import { buildApprovalHandoff } from "./approval_handoff.js";

export const INK_THEME_CSS = `
:root {
  --bg-rice-paper: #F6F3EB;
  --bg-node: #FFFFFF;
  --bg-node-inner: #FAF7F0;
  --ink-primary: #2B2520;
  --ink-secondary: #6A6055;
  --ink-muted: #8E8376;
  --border-ink: #DFD7C8;
  --border-ink-subtle: #EBE5D8;
  --seal-vermilion: #B83B26;
  --seal-bg: rgba(184, 59, 38, 0.08);
  --bamboo-green: #2E5A44;
  --bamboo-bg: rgba(46, 90, 68, 0.08);
  --pine-cyan: #3A6073;
  --pine-light: #EBF1F5;
  --ink-shadow: 0 3px 12px rgba(43, 37, 32, 0.06);
  --node-width: 240px;
  --node-gap-x: 64px;
  --node-gap-y: 20px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-rice-paper: #1B1917;
    --bg-node: #262320;
    --bg-node-inner: #1F1D1A;
    --ink-primary: #E7E2D8;
    --ink-secondary: #ABA092;
    --ink-muted: #7E7467;
    --border-ink: #423B33;
    --border-ink-subtle: #312C26;
    --seal-vermilion: #D9533F;
    --seal-bg: rgba(217, 83, 63, 0.15);
    --bamboo-green: #4D8B6E;
    --bamboo-bg: rgba(77, 139, 110, 0.15);
    --pine-cyan: #6E9FB5;
    --pine-light: rgba(110, 159, 181, 0.15);
    --ink-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg-rice-paper);
  color: var(--ink-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif;
  line-height: 1.45;
  padding: 0 16px 16px 16px;
  /* 36px 标题安全区: 顶栏避让宿主卡片关闭/顶栏控件 */
  padding-top: 36px;
}

/* 顶部标题区 */
.header-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 14px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-ink);
}

.title-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.main-title {
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.5px;
}

.title-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 600;
}

.badge-lane {
  background: var(--bamboo-bg);
  color: var(--bamboo-green);
  border: 1px solid var(--bamboo-green);
}

.badge-status-wait {
  background: var(--pine-light);
  color: var(--pine-cyan);
}

.badge-status-done {
  background: var(--bamboo-bg);
  color: var(--bamboo-green);
}

.lane-desc {
  font-size: 11.5px;
  color: var(--ink-secondary);
}

/* DAG 拓扑视口与画布 */
.dag-viewport-wrapper {
  position: relative;
  margin-bottom: 12px;
}

.dag-viewport {
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 10px 24px 16px 24px;
  background: var(--bg-rice-paper);
  cursor: grab;
  user-select: none;
  scroll-behavior: smooth;
}

.dag-viewport.is-dragging {
  cursor: grabbing;
  scroll-behavior: auto;
}

.dag-viewport::-webkit-scrollbar {
  height: 7px;
}
.dag-viewport::-webkit-scrollbar-track {
  background: #F2ECE0;
  border-radius: 4px;
}
.dag-viewport::-webkit-scrollbar-thumb {
  background: #B8AC9A;
  border-radius: 4px;
}
.dag-viewport::-webkit-scrollbar-thumb:hover {
  background: var(--pine-cyan);
}

.scroll-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-node);
  border: 1.5px solid var(--border-ink);
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  color: var(--pine-cyan);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  transition: all 0.2s;
  font-size: 13px;
  font-weight: 700;
  opacity: 0.92;
}

.scroll-btn:hover {
  background: var(--pine-cyan);
  color: #FFFFFF;
  border-color: var(--pine-cyan);
  transform: translateY(-50%) scale(1.1);
}

.scroll-btn-left { left: 4px; }
.scroll-btn-right { right: 4px; }

.dag-canvas-container {
  position: relative;
  display: inline-block;
  min-width: 100%;
}

.svg-connections {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

.dag-grid {
  display: flex;
  gap: var(--node-gap-x);
  position: relative;
  z-index: 2;
}

.dag-column {
  display: flex;
  flex-direction: column;
  gap: var(--node-gap-y);
  width: var(--node-width);
  flex-shrink: 0;
}

.stage-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border-ink-subtle);
  display: flex;
  justify-content: space-between;
}

/* 节点卡片样式 */
.node-card {
  background: var(--bg-node);
  border: 1px solid var(--border-ink);
  border-radius: 8px;
  box-shadow: var(--ink-shadow);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: all 0.2s ease;
  position: relative;
}

.node-card:hover {
  border-color: var(--pine-cyan);
  box-shadow: 0 4px 18px rgba(43, 37, 32, 0.12);
}

.node-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.node-tag {
  font-size: 10px;
  font-weight: 700;
  color: var(--seal-vermilion);
  background: var(--seal-bg);
  padding: 2px 6px;
  border-radius: 3px;
  letter-spacing: 0.5px;
}

.node-id {
  font-size: 10px;
  color: var(--ink-muted);
  font-family: monospace;
}

.node-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-primary);
  line-height: 1.35;
}

.node-task {
  font-size: 11px;
  color: var(--ink-secondary);
  line-height: 1.4;
  background: var(--bg-node-inner);
  padding: 6px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-ink-subtle);
}

.spec-block {
  font-size: 10.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.spec-item {
  display: flex;
  gap: 4px;
  line-height: 1.3;
}

.spec-label {
  color: var(--ink-muted);
  font-weight: 600;
  flex-shrink: 0;
}

.spec-val {
  color: var(--ink-secondary);
}

.conflict-warning {
  font-size: 10px;
  color: var(--seal-vermilion);
  background: var(--seal-bg);
  border: 1px solid rgba(184, 59, 38, 0.2);
  border-radius: 4px;
  padding: 4px 6px;
  line-height: 1.3;
}

.agent-selector-box {
  background: var(--bg-node-inner);
  border: 1px solid var(--border-ink);
  border-radius: 6px;
  padding: 6px 8px;
  margin-top: 4px;
}

.agent-select-title {
  font-size: 10px;
  color: var(--ink-muted);
  margin-bottom: 2px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.agent-select {
  width: 100%;
  border: none;
  background: transparent;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pine-cyan);
  outline: none;
  cursor: pointer;
}

.agent-select optgroup {
  font-size: 11px;
  font-weight: 700;
  color: var(--ink-muted);
  background: var(--bg-node);
}

.agent-select option {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-primary);
  background: var(--bg-node);
  padding: 3px 6px;
}

/* 底部工具栏 */
.footer-bar {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border-ink);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.roster-summary {
  font-size: 11px;
  color: var(--ink-secondary);
  line-height: 1.4;
  flex: 1;
}

.source-meta {
  font-size: 10px;
  color: var(--ink-muted);
  margin-top: 2px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-secondary {
  background: var(--bg-node);
  color: var(--pine-cyan);
  border: 1px solid var(--pine-cyan);
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: all 0.2s;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--pine-light);
}

.btn-submit {
  background: var(--pine-cyan);
  color: #FFFFFF;
  border: none;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 2px 8px rgba(58, 96, 115, 0.25);
  transition: all 0.2s;
}

.btn-submit:hover:not(:disabled) {
  opacity: 0.92;
  transform: translateY(-1px);
}

.btn-submit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

/* 内嵌自定义助手登记模态弹窗 */
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(27, 25, 23, 0.48);
  backdrop-filter: blur(2px);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.modal-backdrop.active {
  display: flex;
  opacity: 1;
}

.modal-card {
  background: var(--bg-node);
  border: 1px solid var(--border-ink);
  border-radius: 10px;
  width: 90%;
  max-width: 440px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
  padding: 20px;
  transform: translateY(12px) scale(0.98);
  transition: all 0.2s ease;
}

.modal-backdrop.active .modal-card {
  transform: translateY(0) scale(1);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-ink-subtle);
}

.modal-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--ink-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.modal-close {
  background: transparent;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: var(--ink-muted);
  padding: 4px 8px;
  border-radius: 4px;
  line-height: 1;
}

.modal-close:hover {
  background: var(--bg-node-inner);
  color: var(--ink-primary);
}

.modal-desc {
  font-size: 11.5px;
  color: var(--ink-secondary);
  margin-bottom: 14px;
  line-height: 1.45;
}

.modal-form-group {
  margin-bottom: 12px;
}

.modal-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-secondary);
  margin-bottom: 4px;
}

.modal-input {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-node-inner);
  border: 1px solid var(--border-ink);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ink-primary);
  outline: none;
  transition: border-color 0.2s;
}

.modal-input:focus {
  border-color: var(--pine-cyan);
}

.modal-error {
  font-size: 11px;
  color: var(--seal-vermilion);
  margin-top: 4px;
  display: none;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.btn-modal-cancel {
  background: var(--bg-node-inner);
  border: 1px solid var(--border-ink);
  color: var(--ink-secondary);
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.btn-modal-cancel:hover {
  background: var(--border-ink-subtle);
}

.btn-modal-confirm {
  background: var(--pine-cyan);
  border: none;
  color: #FFFFFF;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(58, 96, 115, 0.25);
}

.btn-modal-confirm:hover {
  opacity: 0.92;
}
`;

/**
 * 渲染分组选项或扁平选项
 */
function renderAgentSelectOptions(agents, selectedAgentId, isKnownAgent) {
  let html = "";

  // 1. 若为未授权专员，严格渲染显式禁用占位符 (对齐测试断言)
  if (!isKnownAgent) {
    html += `<option value="" disabled selected>⚠️ 未知或未授权专员: [${escapeHtml(selectedAgentId)}] (请更换)</option>`;
  }

  // 2. 检查是否有 category 分组字段
  const hasCategories = agents.some((a) => a.category);

  if (hasCategories) {
    const categoryOrder = ["core", "engineering", "domain", "thinking", "support", "custom"];
    const grouped = new Map();

    for (const cat of categoryOrder) {
      grouped.set(cat, []);
    }

    for (const a of agents) {
      const cat = a.category && grouped.has(a.category) ? a.category : "custom";
      grouped.get(cat).push(a);
    }

    for (const cat of categoryOrder) {
      const list = grouped.get(cat);
      if (!list || list.length === 0) continue;
      const groupLabel = AGENT_CATEGORIES[cat] || `分类: ${cat}`;
      html += `<optgroup label="${escapeHtml(groupLabel)}">`;
      for (const a of list) {
        const isSelected = isKnownAgent && a.id === selectedAgentId;
        html += `<option value="${escapeHtml(a.id)}" ${isSelected ? "selected" : ""}>${escapeHtml(a.name)} [${escapeHtml(a.permission || a.desc)}]</option>`;
      }
      html += `</optgroup>`;
    }
  } else {
    // 扁平列表渲染
    for (const a of agents) {
      const isSelected = isKnownAgent && a.id === selectedAgentId;
      html += `<option value="${escapeHtml(a.id)}" ${isSelected ? "selected" : ""}>${escapeHtml(a.name)} [${escapeHtml(a.permission || a.desc)}]</option>`;
    }
  }

  // 3. 始终在最底部提供动态自定义添加入口
  html += `<optgroup label="➕ 动态指派">`;
  html += `<option value="__add_custom__">➕ 输入自定义助手 ID / 新助手...</option>`;
  html += `</optgroup>`;

  return html;
}

/**
 * 渲染单个节点的 HTML 卡片
 */
export function renderNodeCard(node, agents, assignedAgentId) {
  const selectedAgentId = assignedAgentId || node.assignedAgent || node.defaultAgent;
  const isKnownAgent = agents.some((a) => a.id === selectedAgentId);

  const dependsStr = node.dependsOn && node.dependsOn.length > 0
    ? escapeHtml(node.dependsOn.join(", "))
    : "无 (初始任务)";

  const writeTargetStr = node.writeTargets && node.writeTargets.length > 0
    ? escapeHtml(node.writeTargets.join(", "))
    : null;

  const optionsHtml = renderAgentSelectOptions(agents, selectedAgentId, isKnownAgent);

  return `
  <div class="node-card" id="node-${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}">
    <div class="node-top">
      <span class="node-tag">${escapeHtml(node.tag)}</span>
      <span class="node-id">#${escapeHtml(node.id)}</span>
    </div>
    <div class="node-title">${escapeHtml(node.title)}</div>
    <div class="node-task">${escapeHtml(node.task || node.desc)}</div>

    <div class="spec-block">
      <div class="spec-item">
        <span class="spec-label">前置依赖:</span>
        <span class="spec-val">${dependsStr}</span>
      </div>
      <div class="spec-item">
        <span class="spec-label">权限边界:</span>
        <span class="spec-val">${escapeHtml(node.boundary)}</span>
      </div>
      <div class="spec-item">
        <span class="spec-label">预期产物:</span>
        <span class="spec-val">${escapeHtml(node.outputs)}</span>
      </div>
      <div class="spec-item">
        <span class="spec-label">验收条件:</span>
        <span class="spec-val">${escapeHtml(node.acceptance)}</span>
      </div>
      ${writeTargetStr ? `
      <div class="spec-item">
        <span class="spec-label">写入目标:</span>
        <span class="spec-val" style="color:var(--seal-vermilion);">${writeTargetStr}</span>
      </div>` : ""}
    </div>

    <div class="agent-selector-box" ${!isKnownAgent ? "style='border-color:var(--seal-vermilion);background:var(--seal-bg);'" : ""}>
      <div class="agent-select-title">
        <span ${!isKnownAgent ? "style='color:var(--seal-vermilion);font-weight:700;'" : ""}>
          ${!isKnownAgent ? "⚠️ 必须手动更换有效专员" : "执行专员 (支持换人)"}
        </span>
      </div>
      <select class="agent-select" data-node-id="${escapeHtml(node.id)}" data-is-invalid="${!isKnownAgent ? "true" : "false"}">
        ${optionsHtml}
      </select>
    </div>
  </div>`;
}

/**
 * 组装完整的水墨风 DAG 看板 HTML
 */
export function renderWorkflowPage(record, dagPlan, agentRoster) {
  const { title, description, id, executed, submitted, status, locked } = record;
  const isLegacyLocked = Boolean(status === "delivery_unknown" || locked === true);
  const isConsumed = Boolean(status === "consumed" || record.consumed === true);
  const isApproved = Boolean(status === "approved" || record.approvalGranted === true);
  // Refresh/resend uses the same backend-derived handoff, including older records.
  const approvalEvent = !isLegacyLocked && record.approvalGranted === true && record.planHash && record.submissionId
    && record.planHash === calculatePlanHash(id, record.nodes, title, description)
    ? buildApprovalHandoff({ workflowId: id, planHash: record.planHash, submissionId: record.submissionId, title, nodes: record.nodes })
    : null;

  let statusText = "待审阅并确认启动";
  let badgeClass = "badge-status-wait";
  let btnInitialText = "确认方案并批准";
  let btnDisabled = false;

  if (isLegacyLocked) {
    statusText = "旧版送达未决 (已锁定)";
    badgeClass = "badge-status-wait";
    btnInitialText = "旧版记录不可自动重发";
    btnDisabled = true;
  } else if (isConsumed) {
    statusText = "已消费执行";
    badgeClass = "badge-status-done";
    btnInitialText = "方案已核销施工";
    btnDisabled = true;
  } else if (isApproved) {
    statusText = "已获批准 (可回传/重发)";
    badgeClass = "badge-status-done";
    btnInitialText = "🚀 再次点击发送已批准方案";
    btnDisabled = false;
  }

  // 构建各列节点 HTML
  const columnsHtml = dagPlan.layers.map((layer) => {
    const cardsHtml = layer.nodes.map((n) =>
      renderNodeCard(n, agentRoster.agents, n.assignedAgent)
    ).join("");

    return `
    <div class="dag-column" data-layer-index="${layer.layerIndex}">
      <div class="stage-header">
        <span>${escapeHtml(layer.stageTag)}</span>
        <span>${layer.nodes.length} 个任务</span>
      </div>
      ${cardsHtml}
    </div>`;
  }).join("");

  // 冲突警告提示块
  const conflictBanner = dagPlan.conflicts.length > 0 ? `
    <div style="margin-bottom: 12px; padding: 8px 12px; background: var(--seal-bg); border: 1px solid var(--seal-vermilion); border-radius: 6px; font-size: 11.5px; color: var(--seal-vermilion);">
      <strong>⚠️ 共享状态并发冲突拦截：</strong>
      ${dagPlan.conflicts.map((c) => escapeHtml(c.reason)).join("<br>")}
    </div>
  ` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - 工作流调度看板 V2</title>
  <style>${INK_THEME_CSS}</style>
</head>
<body>

  <!-- 36px 标题安全区在 body 顶部生效 -->
  <div class="header-bar">
    <div class="title-wrap">
      <div class="main-title">
        <span>🧭</span>
        <span>${escapeHtml(title)}</span>
        <span class="title-badge badge-lane">${escapeHtml(dagPlan.dispatchLane)}</span>
        <span class="title-badge ${badgeClass}" id="status-badge">${statusText}</span>
      </div>
      <div class="lane-desc">${escapeHtml(description || dagPlan.laneReason)}</div>
    </div>
  </div>

  ${conflictBanner}

  <div class="dag-viewport-wrapper">
    <button type="button" class="scroll-btn scroll-btn-left" id="scroll-btn-left" title="向左滑动">‹</button>
    <button type="button" class="scroll-btn scroll-btn-right" id="scroll-btn-right" title="向右滑动">›</button>

    <div class="dag-viewport" id="dag-viewport">
      <div class="dag-canvas-container" id="dag-container">
        <svg class="svg-connections" id="svg-connections">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ink-secondary)" />
            </marker>
            <marker id="arrow-conflict" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--seal-vermilion)" />
            </marker>
          </defs>
        </svg>
        <div class="dag-grid" id="dag-grid">
          ${columnsHtml}
        </div>
      </div>
    </div>
  </div>

  <div class="footer-bar">
    <div class="roster-summary">
      <div id="route-summary">正在计算流水线人员排布...</div>
      <div class="source-meta">专员名录快照来源：${escapeHtml(agentRoster.label)}</div>
    </div>
    <div class="footer-actions">
      <button type="button" class="btn-secondary" id="btn-add-agent" ${btnDisabled ? "disabled" : ""}>
        <span>➕</span>
        <span>添加自定义助手</span>
      </button>
      <button type="button" class="btn-submit" id="btn-submit" ${btnDisabled ? "disabled" : ""}>
        <span>🚀</span>
        <span id="btn-text">${btnInitialText}</span>
      </button>
    </div>
  </div>

  <!-- 内嵌自定义助手登记模态弹窗 (不依赖任何外部弹窗或 prompt) -->
  <div class="modal-backdrop" id="custom-modal-backdrop">
    <div class="modal-card" id="custom-modal">
      <div class="modal-header">
        <div class="modal-title">
          <span>➕</span>
          <span>登记新助手到当前看板</span>
        </div>
        <button type="button" class="modal-close" id="modal-btn-close">✕</button>
      </div>
      <div class="modal-desc">
        登记自定义助手或特化子代理 ID，添加后将同步开放给所有任务节点指派。
      </div>
      <div class="modal-form-group">
        <label class="modal-label" for="modal-agent-id">助手唯一标识 (Agent ID) <span style="color:var(--seal-vermilion)">*</span></label>
        <input type="text" class="modal-input" id="modal-agent-id" placeholder="例如: researcher-1, my-new-agent" autocomplete="off" />
        <div class="modal-error" id="modal-id-error">仅支持 1-64 位英文字母、数字、下划线与短横线</div>
      </div>
      <div class="modal-form-group">
        <label class="modal-label" for="modal-agent-name">显示名称 (可选)</label>
        <input type="text" class="modal-input" id="modal-agent-name" placeholder="例如: 深度检索专员 (默认同 ID)" autocomplete="off" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-modal-cancel" id="modal-btn-cancel">取消</button>
        <button type="button" class="btn-modal-confirm" id="modal-btn-confirm">确认添加并指派</button>
      </div>
    </div>
  </div>

  <!-- 纯 DOM 模态通知弹窗 (彻底杜绝原生 alert 与 prompt) -->
  <div class="modal-backdrop" id="alert-modal-backdrop">
    <div class="modal-card" id="alert-modal">
      <div class="modal-header">
        <div class="modal-title">
          <span id="alert-modal-icon">⚠️</span>
          <span id="alert-modal-title">系统提示</span>
        </div>
        <button type="button" class="modal-close" id="alert-btn-close">✕</button>
      </div>
      <div class="modal-desc" id="alert-modal-msg" style="font-size:12.5px;line-height:1.6;margin-bottom:18px;color:var(--ink-primary);word-break:break-word;">
      </div>
      <div class="modal-actions" style="justify-content:flex-end;">
        <button type="button" class="btn-modal-confirm" id="alert-btn-confirm">知道了</button>
      </div>
    </div>
  </div>

  <script type="application/json" id="workflow-data">${serializeJsonForScript({
    workflowId: id,
    edges: dagPlan.edges,
    status: record.status || "idle",
    approvalGranted: Boolean(record.approvalGranted),
    consumed: Boolean(record.consumed),
    planHash: record.planHash || null,
    submissionId: record.submissionId || null,
    approvalEvent,
    alreadyDone: isConsumed
  })}</script>
</body>
</html>`;
}
