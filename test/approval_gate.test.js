import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  calculatePlanHash,
  isValidSubmissionId,
  getApprovedWorkflowRecord,
  consumeApprovedWorkflowRecord,
  writeWorkflowRecordToStorage,
  readWorkflowRecordFromStorage
} from '../lib/approval_gate.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-gate-v24-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sampleNodes = [
  {
    id: 'step1',
    tag: 'Phase 1',
    title: '架构设计',
    task: '梳理系统全貌',
    boundary: '只读评估',
    outputs: '设计草图',
    acceptance: '无架构单点风险',
    assignedAgent: 'architect',
    dependsOn: [],
    writeTargets: []
  },
  {
    id: 'step2',
    tag: 'Phase 2',
    title: '核心编码',
    task: '编写核心逻辑',
    boundary: '工作区隔离',
    outputs: '源码与测试',
    acceptance: '单元测试全绿',
    assignedAgent: 'coder',
    dependsOn: ['step1'],
    writeTargets: ['src/core.js']
  }
];

test('calculatePlanHash: 包含 title/desc 及每个节点的五要素契约，任何改动都会改变指纹', () => {
  const hash1 = calculatePlanHash('wf_001', sampleNodes, '大项目', '协同5.0规划');
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 32);

  // 1. 改动 title 导致 hash 变化
  const hashDiffTitle = calculatePlanHash('wf_001', sampleNodes, '改动标题', '协同5.0规划');
  assert.notEqual(hash1, hashDiffTitle);

  // 2. 改动 description 导致 hash 变化
  const hashDiffDesc = calculatePlanHash('wf_001', sampleNodes, '大项目', '改动说明');
  assert.notEqual(hash1, hashDiffDesc);

  // 3. 改动节点的 task/boundary/acceptance/outputs/assignedAgent 导致 hash 变化
  const nodesDiffTask = JSON.parse(JSON.stringify(sampleNodes));
  nodesDiffTask[0].task = '被篡改的任务';
  assert.notEqual(hash1, calculatePlanHash('wf_001', nodesDiffTask, '大项目', '协同5.0规划'));

  const nodesDiffBoundary = JSON.parse(JSON.stringify(sampleNodes));
  nodesDiffBoundary[0].boundary = '写全盘';
  assert.notEqual(hash1, calculatePlanHash('wf_001', nodesDiffBoundary, '大项目', '协同5.0规划'));

  const nodesDiffAccept = JSON.parse(JSON.stringify(sampleNodes));
  nodesDiffAccept[0].acceptance = '无要求';
  assert.notEqual(hash1, calculatePlanHash('wf_001', nodesDiffAccept, '大项目', '协同5.0规划'));

  const nodesDiffAgent = JSON.parse(JSON.stringify(sampleNodes));
  nodesDiffAgent[0].assignedAgent = 'hacker';
  assert.notEqual(hash1, calculatePlanHash('wf_001', nodesDiffAgent, '大项目', '协同5.0规划'));
});

test('isValidSubmissionId: 严格校验 sub_ 前缀与安全字符集', () => {
  assert.equal(isValidSubmissionId('sub_12345678'), true);
  assert.equal(isValidSubmissionId('sub_abc-123_xyz'), true);
  assert.equal(isValidSubmissionId('sub_'), false);
  assert.equal(isValidSubmissionId('bad_12345'), false);
  assert.equal(isValidSubmissionId(''), false);
  assert.equal(isValidSubmissionId(null), false);
});

test('writeWorkflowRecordToStorage: 临时文件 + renameSync 原子替换，防止写入文件截断', () => {
  const f = fixture();
  try {
    const rec = { id: 'wf_atomic_test', title: '原子落盘测试' };
    writeWorkflowRecordToStorage(f.dir, rec);
    const read = readWorkflowRecordFromStorage(f.dir, 'wf_atomic_test');
    assert.deepEqual(read, rec);
    // 确认不存在残留的 .tmp 临时文件
    assert.equal(existsSync(join(f.dir, 'workflows', 'wf_atomic_test.json')), true);
  } finally {
    f.cleanup();
  }
});

test('getApprovedWorkflowRecord: 未获批准时拒绝返回凭据', () => {
  const f = fixture();
  try {
    const rec = {
      id: 'wf_unapproved',
      title: '未批准项目',
      nodes: sampleNodes,
      approvalGranted: false,
      status: 'idle'
    };
    writeWorkflowRecordToStorage(f.dir, rec);

    const res = getApprovedWorkflowRecord(f.dir, 'wf_unapproved');
    assert.equal(res.found, true);
    assert.equal(res.approved, false);
    assert.match(res.message, /尚未获得用户批准/);
  } finally {
    f.cleanup();
  }
});

test('getApprovedWorkflowRecord: 存储篡改检测 (存储内容变了而 hash 没变时安全拒绝)', () => {
  const f = fixture();
  try {
    const planHash = calculatePlanHash('wf_tampered', sampleNodes, '原标题', '原说明');
    const rec = {
      id: 'wf_tampered',
      title: '原标题',
      description: '原说明',
      nodes: sampleNodes,
      approvalGranted: true,
      status: 'approved',
      planHash,
      submissionId: 'sub_test_123'
    };
    writeWorkflowRecordToStorage(f.dir, rec);

    // 此时读正常
    const resNormal = getApprovedWorkflowRecord(f.dir, 'wf_tampered');
    assert.equal(resNormal.approved, true);

    // 篡改节点任务但保留原 planHash
    rec.nodes[0].task = '偷偷篡改任务';
    writeWorkflowRecordToStorage(f.dir, rec);

    const resTampered = getApprovedWorkflowRecord(f.dir, 'wf_tampered');
    assert.equal(resTampered.approved, false);
    assert.equal(resTampered.hashMismatch, true);
    assert.match(resTampered.message, /已被修改/);
  } finally {
    f.cleanup();
  }
});

test('consumeApprovedWorkflowRecord: 首次消费成功核销，二次消费返回 duplicate 幂等收据防重复派发', () => {
  const f = fixture();
  try {
    const planHash = calculatePlanHash('wf_consume_test', sampleNodes, '大项目', '协同规划');
    const submissionId = 'sub_stable_001';
    const rec = {
      id: 'wf_consume_test',
      title: '大项目',
      description: '协同规划',
      nodes: sampleNodes,
      dagPlan: { dispatchLane: 'Direct', laneReason: '测试' },
      approvalGranted: true,
      status: 'approved',
      planHash,
      submissionId,
      dispatchText: '派发文本'
    };
    writeWorkflowRecordToStorage(f.dir, rec);

    // 1. 首次消费
    const firstRes = consumeApprovedWorkflowRecord(f.dir, 'wf_consume_test', planHash, submissionId);
    assert.equal(firstRes.ok, true);
    assert.equal(firstRes.duplicate, false);
    assert.equal(firstRes.alreadyConsumed, false);
    assert.equal(firstRes.status, 'consumed');
    assert.ok(firstRes.receipt.consumedAt);
    assert.equal(firstRes.receipt.submissionId, submissionId);

    // 验证磁盘已落盘
    const diskRec = readWorkflowRecordFromStorage(f.dir, 'wf_consume_test');
    assert.equal(diskRec.consumed, true);
    assert.equal(diskRec.status, 'consumed');

    // 2. 二次消费 (相同凭证)：必须返回 duplicate: true 与已有 receipt，不抛异常
    const secondRes = consumeApprovedWorkflowRecord(f.dir, 'wf_consume_test', planHash, submissionId);
    assert.equal(secondRes.ok, true);
    assert.equal(secondRes.duplicate, true);
    assert.equal(secondRes.alreadyConsumed, true);
    assert.deepEqual(secondRes.receipt, firstRes.receipt);
    assert.match(secondRes.message, /已安全拦截/);
  } finally {
    f.cleanup();
  }
});

test('consumeApprovedWorkflowRecord: 传入不匹配的 planHash 或 submissionId 时强行拒绝', () => {
  const f = fixture();
  try {
    const planHash = calculatePlanHash('wf_mismatch', sampleNodes, '大项目', '协同规划');
    const submissionId = 'sub_valid_123';
    const rec = {
      id: 'wf_mismatch',
      title: '大项目',
      description: '协同规划',
      nodes: sampleNodes,
      approvalGranted: true,
      status: 'approved',
      planHash,
      submissionId
    };
    writeWorkflowRecordToStorage(f.dir, rec);

    // 错误的 planHash
    assert.throws(() => {
      consumeApprovedWorkflowRecord(f.dir, 'wf_mismatch', 'wrong_hash_12345678901234567890', submissionId);
    }, /方案指纹不匹配/);

    // 错误的 submissionId
    assert.throws(() => {
      consumeApprovedWorkflowRecord(f.dir, 'wf_mismatch', planHash, 'sub_wrong_id');
    }, /提交标识不匹配/);
  } finally {
    f.cleanup();
  }
});

test('旧版 delivery_unknown 历史记录不可自动重发或消费', () => {
  const f = fixture();
  try {
    const rec = {
      id: 'wf_legacy_unknown',
      title: '旧版未知投递',
      status: 'delivery_unknown',
      locked: true,
      approvalGranted: true,
      nodes: sampleNodes
    };
    writeWorkflowRecordToStorage(f.dir, rec);

    const getRes = getApprovedWorkflowRecord(f.dir, 'wf_legacy_unknown');
    assert.equal(getRes.isLegacyDeliveryUnknown, true);
    assert.equal(getRes.approved, false);
    assert.match(getRes.message, /旧版迁移前的投递未决历史记录/);

    assert.throws(() => {
      consumeApprovedWorkflowRecord(f.dir, 'wf_legacy_unknown', 'any_hash', 'sub_any');
    }, /旧版 delivery_unknown 历史记录不可消费派发/);
  } finally {
    f.cleanup();
  }
});
