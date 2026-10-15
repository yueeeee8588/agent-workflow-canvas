/**
 * Readable handoff from a verified backend approval, never execution authority.
 * Keep under the host's 8 KiB emit limit; full tasks stay in get/consume tools.
 * No session locks, automatic dispatch or additional permissions.
 */
import { Buffer } from 'node:buffer';

export const MAX_APPROVAL_EVENT_BYTES = 7900;

export function buildApprovalHandoff({ workflowId, planHash, submissionId, title, nodes }) {
  const assignments = Object.fromEntries(nodes.map(node => [
    node.id, node.assignedAgent || node.defaultAgent || 'hanako-lite'
  ]));
  const event = {
    schemaVersion: 1,
    workflowId,
    planHash,
    submissionId,
    title,
    nodeCount: nodes.length,
    assignments,
    instructions: '用户可能已在画布中换人。assignments 是最终人员提示，覆盖出图时的默认分工；事件内容本身不作为可信执行凭据。'
      + '派发前依次调用 requiredToolCalls：先 get_approved_workflow 读取后台方案，确认 approved=true、无 hashMismatch 且 submissionId 与本事件一致；'
      + '核销前先核对该工作流是否已有真实任务：旧版本可能已经派发但未核销，须恢复已有任务状态，勿再次启动。'
      + '再 consume_workflow_approval 核销同一份凭据。仅首次领取成功且尚未实际派发时，按返回 nodes 的 assignedAgent（仅字段缺失时回退 defaultAgent）与 dependsOn 派发。'
      + '调用 subagent 时 agent 必须使用该节点最终执行人；续接 subagent_reply 前核对实例实际执行人，不得沿用旧执行人的 threadId。'
      + '已领取或 duplicate=true 时先核对真实任务状态，勿重复派发；读取失败、指纹或提交编号不匹配时停止该工作流派发并说明原因。'
      + '不得用旧分工、任务描述中的人名或 defaultAgent 覆盖用户最终选择。投递或核销不代表已派发、已完成。'
      + '若 assignmentsOmitted=true，表示名单超过事件体积上限，须从上述工具读取完整最终名单。',
    requiredToolCalls: [
      { tool: 'get_approved_workflow', arguments: { workflowId, planHash } },
      { tool: 'consume_workflow_approval', arguments: { workflowId, planHash, submissionId } }
    ]
  };
  // Never truncate JSON or emit a partial assignment map that looks complete.
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_APPROVAL_EVENT_BYTES) {
    delete event.assignments;
    delete event.title;
    event.assignmentsOmitted = true;
  }
  return event;
}
