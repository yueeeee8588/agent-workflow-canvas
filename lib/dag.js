/**
 * DAG 拓扑解析引擎与协同 5.0 调度逻辑 (V2 增强版)
 * 涵盖：显式 dependsOn 校验、循环/未知/自依赖检测、旧 column 兼容转换、
 * Work Package 属性解析、资源规范化、全局可达性 Shared Write 冲突无环串行化、
 * 依据 5.0 核心收益 (technicalUnknown/contextIsolation/specialist) 的精确 Lane 推导。
 */

import { sanitizeString, validateNodeId } from "./security.js";

export class DagValidationError extends Error {
  constructor(message, code = "DAG_VALIDATION_ERROR", details = {}) {
    super(message);
    this.name = "DagValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 资源写入目标路径规范化 (防大小写、反斜杠、相对路径差异导致冲突漏检)
 */
export function normalizeResourceTarget(target) {
  if (!target || typeof target !== "string") return "";
  let clean = target.trim().replace(/\\/g, "/");
  clean = clean.replace(/^\.\//, "");
  // 规范化多重斜杠
  clean = clean.replace(/\/+/g, "/");
  // 大小写统一归一化
  return clean.toLowerCase();
}

/**
 * 校验并规范化节点列表，转换旧 column 结构为标准 dependsOn DAG
 */
export function normalizeNodes(rawNodes) {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new DagValidationError("工作流必须至少包含 1 个有效节点", "EMPTY_NODES");
  }

  const nodeMap = new Map();
  const idList = [];

  // 1. 初步提取与防重复节点检查
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i] || {};
    const rawId = sanitizeString(raw.id || `node_${i + 1}`, 64);
    // 强制正则安全校验，拦截非字母数字减号下划线的非法字符（如 </script>）
    const id = validateNodeId(rawId);

    if (nodeMap.has(id)) {
      throw new DagValidationError(
        `发现重复的节点 ID: "${id}"，DAG 图中各节点 ID 必须全局唯一`,
        "DUPLICATE_NODE_ID",
        { id }
      );
    }

    const title = sanitizeString(raw.title, 100, `阶段 ${i + 1}`);
    const tag = sanitizeString(raw.tag, 40, `Phase ${i + 1}`);
    const desc = sanitizeString(raw.desc || raw.task, 500, "");
    const task = sanitizeString(raw.task || raw.desc, 500, title);
    const boundary = sanitizeString(raw.boundary, 300, "遵从所属 Agent 标准权限边界");
    const outputs = sanitizeString(raw.outputs, 300, "产出完整结论与结构化结果");
    const acceptance = sanitizeString(raw.acceptance, 300, "结果符合预期且经独立验证");
    const defaultAgent = sanitizeString(raw.defaultAgent || raw.assignedAgent, 64, "hanako-lite");
    const assignedAgent = raw.assignedAgent ? sanitizeString(raw.assignedAgent, 64) : null;

    // 协同 5.0 决策依据字段
    const technicalUnknown = Boolean(raw.technicalUnknown);
    const contextIsolation = Boolean(raw.contextIsolation);
    const independentValue = raw.independentValue !== undefined ? Boolean(raw.independentValue) : true;

    // writeTargets: 声明写入或变更的共享资源并进行严格规范化
    let rawTargets = [];
    if (Array.isArray(raw.writeTargets)) {
      rawTargets = raw.writeTargets;
    } else if (raw.writeTarget) {
      rawTargets = [raw.writeTarget];
    }

    const writeTargets = rawTargets
      .map((w) => sanitizeString(w, 200))
      .filter(Boolean);

    const normalizedWriteTargets = writeTargets
      .map(normalizeResourceTarget)
      .filter(Boolean);

    // dependsOn 提取
    let dependsOn = null;
    if (Array.isArray(raw.dependsOn)) {
      dependsOn = raw.dependsOn.map((d) => sanitizeString(d, 64)).filter(Boolean);
    }

    const column = Number.isInteger(raw.column) ? raw.column : null;

    const normalized = {
      id,
      tag,
      title,
      desc,
      task,
      boundary,
      outputs,
      acceptance,
      defaultAgent,
      assignedAgent,
      technicalUnknown,
      contextIsolation,
      independentValue,
      writeTargets,
      normalizedWriteTargets,
      dependsOn,
      column,
      originalIndex: i
    };

    nodeMap.set(id, normalized);
    idList.push(id);
  }

  // 2. 旧 nodes column 兼容转依赖 DAG
  const hasExplicitDependsOn = Array.from(nodeMap.values()).some((n) => n.dependsOn !== null);

  if (!hasExplicitDependsOn) {
    const colGroups = new Map();
    for (const node of nodeMap.values()) {
      const col = node.column ?? (node.originalIndex + 1);
      node.column = col;
      if (!colGroups.has(col)) colGroups.set(col, []);
      colGroups.get(col).push(node.id);
    }

    const sortedCols = Array.from(colGroups.keys()).sort((a, b) => a - b);
    for (let cIdx = 0; cIdx < sortedCols.length; cIdx++) {
      const currentCol = sortedCols[cIdx];
      const currentIds = colGroups.get(currentCol);
      if (cIdx === 0) {
        for (const nid of currentIds) {
          nodeMap.get(nid).dependsOn = [];
        }
      } else {
        const prevCol = sortedCols[cIdx - 1];
        const prevIds = colGroups.get(prevCol);
        for (const nid of currentIds) {
          nodeMap.get(nid).dependsOn = [...prevIds];
        }
      }
    }
  } else {
    for (const node of nodeMap.values()) {
      if (!Array.isArray(node.dependsOn)) {
        node.dependsOn = [];
      }
    }
  }

  // 3. 自依赖与未知依赖校验
  for (const node of nodeMap.values()) {
    if (node.dependsOn.includes(node.id)) {
      throw new DagValidationError(
        `节点 "${node.id}" 存在自依赖 (dependsOn 包含了自身)`,
        "SELF_DEPENDENCY_ERROR",
        { id: node.id }
      );
    }

    for (const depId of node.dependsOn) {
      if (!nodeMap.has(depId)) {
        throw new DagValidationError(
          `节点 "${node.id}" 依赖了未知的节点 ID: "${depId}"`,
          "UNKNOWN_DEPENDENCY_ERROR",
          { id: node.id, unknownDependency: depId }
        );
      }
    }
  }

  // 4. 循环依赖校验 (DFS 三色标记法)
  const visitState = new Map();
  const currentStack = [];

  function dfsDetectCycle(u) {
    visitState.set(u, 1);
    currentStack.push(u);

    const node = nodeMap.get(u);
    for (const v of node.dependsOn) {
      const state = visitState.get(v) || 0;
      if (state === 1) {
        const cycleStartIndex = currentStack.indexOf(v);
        const cyclePath = [...currentStack.slice(cycleStartIndex), v].join(" ➔ ");
        throw new DagValidationError(
          `检测到工作流存在循环依赖闭环: ${cyclePath}`,
          "CYCLE_DEPENDENCY_ERROR",
          { cyclePath, source: u, target: v }
        );
      }
      if (state === 0) {
        dfsDetectCycle(v);
      }
    }

    currentStack.pop();
    visitState.set(u, 2);
  }

  for (const id of idList) {
    if ((visitState.get(id) || 0) === 0) {
      dfsDetectCycle(id);
    }
  }

  return Array.from(nodeMap.values());
}

/**
 * 计算 DAG 中的全节点可达性矩阵 (Transitive Closure)
 * @param {Array} nodes 节点列表
 * @returns {Function} (fromId, toId) => boolean
 */
export function buildReachabilityMap(nodes) {
  const nodeIds = nodes.map((n) => n.id);
  const reachable = new Map();

  for (const id of nodeIds) {
    reachable.set(id, new Set());
  }

  // 直接依赖边
  for (const n of nodes) {
    for (const depId of n.dependsOn) {
      reachable.get(depId)?.add(n.id);
    }
  }

  // Floyd-Warshall 风格计算传递闭包
  for (const k of nodeIds) {
    for (const i of nodeIds) {
      if (reachable.get(i)?.has(k)) {
        for (const j of nodeIds) {
          if (reachable.get(k)?.has(j)) {
            reachable.get(i)?.add(j);
          }
        }
      }
    }
  }

  return (fromId, toId) => reachable.get(fromId)?.has(toId) || false;
}

/**
 * 拓扑分层、全局 Shared Write 冲突消解与 5.0 精确派发推导
 * 彻底消灭“跨层但无路径导致的重叠写”盲区
 */
export function buildDagPlan(nodes) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const conflicts = [];
  const serializedEdges = [];

  // 1. 全局无死角冲突消解循环：
  // 检查任意两节点对，只要无因果先后关系且存在规范化资源交集，立即建立无环串行边
  let conflictResolved = true;
  while (conflictResolved) {
    conflictResolved = false;
    const isReachable = buildReachabilityMap(nodes);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const nA = nodes[i];
        const nB = nodes[j];

        // 若已有先后依赖关系 (A可达B 或 B可达A)，天然串行，不存在并发写冲突
        if (isReachable(nA.id, nB.id) || isReachable(nB.id, nA.id)) {
          continue;
        }

        // 检查规范化后的写入资源是否有交集
        const shared = (nA.normalizedWriteTargets || []).filter((w) =>
          (nB.normalizedWriteTargets || []).includes(w)
        );

        if (shared.length > 0) {
          // 拓扑序定向：优先基于原始偏序，后声明的依赖先声明的
          const first = nA.originalIndex <= nB.originalIndex ? nA : nB;
          const second = nA.originalIndex <= nB.originalIndex ? nB : nA;

          // 尝试添加串行边
          second.dependsOn.push(first.id);

          // 双保险：重跑环检测验证添加边后仍为严格 DAG
          const cycleCheckMap = new Map(nodes.map((n) => [n.id, n]));
          const vState = new Map();
          let cycleDetected = false;

          function verifyNoCycle(u) {
            vState.set(u, 1);
            for (const v of cycleCheckMap.get(u).dependsOn) {
              if (vState.get(v) === 1) {
                cycleDetected = true;
                return;
              }
              if (!vState.get(v)) verifyNoCycle(v);
            }
            vState.set(u, 2);
          }

          for (const n of nodes) {
            if (!vState.get(n.id)) verifyNoCycle(n.id);
          }

          if (cycleDetected) {
            // 若该方向成环，则尝试反向定向
            second.dependsOn.pop();
            first.dependsOn.push(second.id);
          }

          conflicts.push({
            nodeA: first.id,
            nodeB: second.id,
            sharedResources: shared,
            resolution: "serialize",
            reason: `节点 [${first.id}] 与 [${second.id}] 竞争写入共享目标 [${shared.join(", ")}]，已建立拓扑定向串行边消解并发冲突。`
          });

          serializedEdges.push({ from: first.id, to: second.id, resource: shared[0] });

          conflictResolved = true;
          break; // 边结构已改变，跳出重新计算闭包
        }
      }
      if (conflictResolved) break;
    }
  }

  // 2. 计算各节点的拓扑分层 (Layer / Rank)
  const layerMap = new Map();

  function getLayer(id) {
    if (layerMap.has(id)) return layerMap.get(id);
    const node = nodeMap.get(id);
    if (!node.dependsOn || node.dependsOn.length === 0) {
      layerMap.set(id, 0);
      return 0;
    }
    let maxDepLayer = 0;
    for (const depId of node.dependsOn) {
      const depL = getLayer(depId);
      if (depL > maxDepLayer) maxDepLayer = depL;
    }
    const myLayer = maxDepLayer + 1;
    layerMap.set(id, myLayer);
    return myLayer;
  }

  for (const node of nodes) {
    getLayer(node.id);
  }

  // 3. 构建分层结构与布局
  const finalLayersMap = new Map();
  for (const node of nodes) {
    const l = layerMap.get(node.id);
    node.layer = l;
    if (!finalLayersMap.has(l)) finalLayersMap.set(l, []);
    finalLayersMap.get(l).push(node);
  }

  const sortedFinalLayerKeys = Array.from(finalLayersMap.keys()).sort((a, b) => a - b);
  const layers = [];
  let maxConcurrency = 0;

  for (const lKey of sortedFinalLayerKeys) {
    const layerNodes = finalLayersMap.get(lKey);
    layerNodes.forEach((n, idx) => {
      n.row = idx;
    });
    if (layerNodes.length > maxConcurrency) {
      maxConcurrency = layerNodes.length;
    }
    layers.push({
      layerIndex: lKey,
      stageTag: `Stage ${lKey + 1}`,
      nodes: layerNodes
    });
  }

  // 4. 收集所有 DAG 边
  const edges = [];
  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      const isConflictSerialized = serializedEdges.some(
        (e) => e.from === depId && e.to === node.id
      );
      edges.push({
        from: depId,
        to: node.id,
        type: isConflictSerialized ? "conflict-serialized" : "explicit"
      });
    }
  }

  // 5. 协同 5.0 精准派发路线推导 (依据独立收益、技术未知、上下文隔离、专家分工)
  const leadAgents = new Set(["hanako", "main"]);

  const hasTechnicalUnknown = nodes.some((n) => n.technicalUnknown);
  const hasContextIsolation = nodes.some((n) => n.contextIsolation);
  const allNoIndependentValue = nodes.every((n) => n.independentValue === false);
  const hasSpecialistWorker = nodes.some((n) => {
    const ag = n.assignedAgent || n.defaultAgent;
    return ag && !leadAgents.has(ag);
  });

  let dispatchLane = "Direct Lane";
  let laneReason = "";

  if (allNoIndependentValue) {
    dispatchLane = "Direct Lane";
    laneReason = "所有节点均无独立拆分收益，拆分后无明显价值，主 Agent 自行闭环完成更为直接。";
  } else if (nodes.length === 1 && !hasTechnicalUnknown && !hasContextIsolation && !hasSpecialistWorker) {
    dispatchLane = "Direct Lane";
    laneReason = "单一集中任务，无技术未知且无需上下文隔离，主 Agent 直接执行效率最高。";
  } else if (maxConcurrency >= 2 && !allNoIndependentValue) {
    dispatchLane = "Matrix Lane";
    laneReason = `存在 ${maxConcurrency} 个正交独立工作包且已消解共享写入冲突，采用多 Agent 正交并发调度，大幅提高任务覆盖与吞吐。`;
  } else {
    // 单链、存在技术未知、上下文隔离、或指定了专项专员
    dispatchLane = "Worker Lane";
    const triggers = [];
    if (hasTechnicalUnknown) triggers.push("技术未知取证");
    if (hasContextIsolation) triggers.push("主会话上下文隔离");
    if (hasSpecialistWorker) triggers.push("专项能力专员派发");
    if (maxConcurrency === 1 && nodes.length > 1) triggers.push("单链独立工作包逐步推进");

    laneReason = `符合 Worker Lane 依据：[${triggers.join("、")}]，按实际收益独立完成，简短回报状态、产物、验证证据与问题；主控按有效精简契约复核。`;
  }

  return {
    nodes,
    layers,
    edges,
    conflicts,
    dispatchLane,
    laneReason,
    stats: {
      totalNodes: nodes.length,
      totalLayers: layers.length,
      maxConcurrency,
      hasConflicts: conflicts.length > 0
    }
  };
}
