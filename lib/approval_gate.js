/**
 * 工作流方案指纹计算与可信审批凭证管理 (V2.4.0)
 * 采用快捷回复卡片回传架构：
 * 1. 移除会话级 tools/pre-execute 黑名单锁（用户明确要求不锁会话）；
 * 2. 方案全量指纹 (planHash) 包含标题、说明、各工作包五要素契约（任务、边界、验收、产物、责任人、依赖、写目标）；
 * 3. submissionId 由服务端基于完整 randomUUID() 权威生成，禁止客户端指定；明确定义为公开去重 ID，非权限 token；
 * 4. 领取仅标记为 claimed/consumed，绝不标记为 dispatched/executed（不冒充派发或执行终态）；
 * 5. 采用临时文件 + renameSync 原子替换落盘，单进程防崩溃截断；
 * 6. 读可信后端凭据与原子消费时重新基于存储内容比对全量指纹，防止存储变异；
 * 7. 严格识别旧 delivery_unknown 历史记录，禁止自动重发。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkflowId } from './security.js';
import { buildApprovalHandoff } from './approval_handoff.js';

/**
 * 权威生成稳定 submissionId (公开去重 ID，非权限 token)
 */
export function generateSubmissionId() {
  return `sub_${randomUUID()}`;
}

/**
 * 校验 submissionId 格式 (必须为权威 sub_UUID 格式)
 */
export function isValidSubmissionId(subId) {
  return typeof subId === 'string' && /^sub_[a-zA-Z0-9_-]{1,64}$/.test(subId.trim());
}

/**
 * 计算方案全量确定性指纹 (planHash)
 * 包含工作流标题、说明、各工作包的关键展示与契约五要素（边界、验收、任务、产物、责任人、依赖、写目标）
 */
export function calculatePlanHash(workflowId, nodes = [], title = '', description = '') {
  validateWorkflowId(workflowId);
  const normalizedNodes = (Array.isArray(nodes) ? nodes : [])
    .map(n => ({
      id: String(n.id || ''),
      tag: String(n.tag || ''),
      title: String(n.title || ''),
      task: String(n.task || n.desc || ''),
      desc: String(n.desc || n.task || ''),
      boundary: String(n.boundary || ''),
      outputs: String(n.outputs || ''),
      acceptance: String(n.acceptance || ''),
      assignedAgent: String(n.assignedAgent || n.defaultAgent || 'coder'),
      dependsOn: Array.isArray(n.dependsOn) ? [...n.dependsOn].sort() : [],
      writeTargets: Array.isArray(n.writeTargets) ? [...n.writeTargets].sort() : []
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const payload = JSON.stringify({
    workflowId,
    title: String(title || ''),
    description: String(description || ''),
    nodes: normalizedNodes
  });

  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * 读取工作流记录 (可信 Server 存储)
 */
export function readWorkflowRecordFromStorage(dataDir, workflowId) {
  validateWorkflowId(workflowId);
  const p = join(dataDir, 'workflows', `${workflowId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 保存工作流记录 (使用临时文件 + renameSync 原子替换)
 */
export function writeWorkflowRecordToStorage(dataDir, rec) {
  validateWorkflowId(rec.id);
  const targetPath = join(dataDir, 'workflows', `${rec.id}.json`);
  const tmpPath = join(dataDir, 'workflows', `${rec.id}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

/**
 * 读取可信后端批准的记录 (get_approved_workflow)
 * 重新基于存储的 title/description/nodes 全量契约字段重新计算 hash 对比，防止存储篡改
 */
export function getApprovedWorkflowRecord(dataDir, workflowId, expectedPlanHash = null, hostAudit = {}) {
  validateWorkflowId(workflowId);
  const rec = readWorkflowRecordFromStorage(dataDir, workflowId);
  if (!rec) {
    return {
      found: false,
      error: 'not_found',
      message: `未找到指定工作流 [${workflowId}]`
    };
  }

  // 检查旧历史记录是否处于迁移前的 delivery_unknown 锁定
  if (rec.status === 'delivery_unknown' || rec.locked === true) {
    return {
      found: true,
      approved: false,
      isLegacyDeliveryUnknown: true,
      status: rec.status,
      message: '该记录属于旧版迁移前的投递未决历史记录，不可自动重发，需重新规划生成新画布。'
    };
  }

  if (rec.approvalGranted !== true) {
    return {
      found: true,
      approved: false,
      status: rec.status || 'pending_approval',
      message: '该工作流尚未获得用户批准，不可读取派发凭据。'
    };
  }

  // 重新计算全量指纹进行严格核验
  const computedHash = calculatePlanHash(rec.id, rec.nodes, rec.title, rec.description);
  if (rec.planHash && rec.planHash !== computedHash) {
    return {
      found: true,
      approved: false,
      hashMismatch: true,
      message: `方案存储内容已被修改，持久化指纹 (${rec.planHash}) 与当前方案计算指纹 (${computedHash}) 不一致！`
    };
  }

  if (expectedPlanHash && computedHash !== expectedPlanHash) {
    return {
      found: true,
      approved: true,
      hashMismatch: true,
      expectedPlanHash,
      actualPlanHash: computedHash,
      message: `方案指纹不匹配：期望 ${expectedPlanHash}，后端实际为 ${computedHash}。`
    };
  }

  return {
    found: true,
    approved: true,
    workflowId: rec.id,
    title: rec.title,
    description: rec.description,
    status: rec.status,
    planHash: computedHash,
    submissionId: rec.submissionId,
    approvedAt: rec.approvedAt,
    consumed: Boolean(rec.consumed || rec.claimed),
    consumedAt: rec.consumedAt || rec.claimedAt || null,
    receipt: rec.receipt || null,
    approvalEvent: buildApprovalHandoff({ workflowId: rec.id, planHash: computedHash, submissionId: rec.submissionId, title: rec.title, nodes: rec.nodes }),
    nodes: rec.nodes,
    dagPlan: rec.dagPlan,
    dispatchText: rec.dispatchText || '',
    message: '已成功获取可信后端批准方案 (submissionId为公开去重标识，非权限凭据)'
  };
}

/**
 * 原子消费审批凭据 (consume_workflow_approval)
 * 只能标记为 claimed/consumed，绝不标记为 dispatched/executed
 * 防重复派发：重复请求返回 duplicate: true 与已有 receipt，不抛异常，不重复派发
 */
export function consumeApprovedWorkflowRecord(dataDir, workflowId, planHash, submissionId, hostAudit = {}) {
  validateWorkflowId(workflowId);
  if (!isValidSubmissionId(submissionId)) {
    throw new Error(`非法 submissionId 格式: "${submissionId}"`);
  }

  const rec = readWorkflowRecordFromStorage(dataDir, workflowId);
  if (!rec) {
    throw new Error(`未找到指定工作流 [${workflowId}]`);
  }

  if (rec.status === 'delivery_unknown' || rec.locked === true) {
    throw new Error('旧版 delivery_unknown 历史记录不可消费派发');
  }

  if (rec.approvalGranted !== true) {
    throw new Error(`工作流 [${workflowId}] 尚未获得用户批准，拒绝领取派发凭据`);
  }

  // 严格核验：动态重新计算方案全量指纹，杜绝篡改
  const currentComputedHash = calculatePlanHash(rec.id, rec.nodes, rec.title, rec.description);
  if (rec.planHash !== currentComputedHash) {
    throw new Error(`方案存储已被篡改，持久化指纹与当前内容不一致`);
  }

  if (currentComputedHash !== planHash) {
    throw new Error(`方案指纹不匹配: 传入 ${planHash} != 批准记录 ${currentComputedHash}`);
  }

  if (rec.submissionId !== submissionId) {
    throw new Error(`提交标识不匹配: 传入 ${submissionId} != 批准记录 ${rec.submissionId}`);
  }

  // 重复消费拦截 (幂等收据，重复调用不抛错，返回 duplicate)
  if (rec.consumed === true || rec.claimed === true || rec.status === 'consumed' || rec.status === 'claimed') {
    return {
      ok: true,
      duplicate: true,
      alreadyConsumed: true,
      alreadyClaimed: true,
      workflowId: rec.id,
      submissionId: rec.submissionId,
      planHash: currentComputedHash,
      receipt: rec.receipt || {
        workflowId: rec.id,
        submissionId: rec.submissionId,
        planHash: currentComputedHash,
        claimedAt: rec.consumedAt || rec.claimedAt
      },
      message: '该批准凭据已被领取，重复调用已安全拦截；请核查已有 task 执行状态，勿重复派发。'
    };
  }

  // 首次消费：原子更新状态为 claimed / consumed（绝不得标为 dispatched/executed）
  const claimedAt = new Date().toISOString();
  const receipt = {
    workflowId: rec.id,
    submissionId: rec.submissionId,
    planHash: currentComputedHash,
    claimedAt,
    consumedAt: claimedAt,
    claimedByAgent: hostAudit?.agentId || null
  };

  rec.claimed = true;
  rec.consumed = true;
  rec.claimedAt = claimedAt;
  rec.consumedAt = claimedAt;
  rec.status = 'consumed';
  rec.receipt = receipt;

  writeWorkflowRecordToStorage(dataDir, rec);

  return {
    ok: true,
    duplicate: false,
    alreadyConsumed: false,
    alreadyClaimed: false,
    workflowId: rec.id,
    submissionId: rec.submissionId,
    planHash: currentComputedHash,
    receipt,
    nodes: rec.nodes,
    dagPlan: rec.dagPlan,
    dispatchText: rec.dispatchText || '',
    status: 'consumed',
    message: '审批凭据已成功核销领取（已标记为 consumed，不代表执行已完成）'
  };
}
