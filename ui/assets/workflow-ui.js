export function initializeWorkflow(data, hana) {
  function resize() {
    hana.ui.resize({ height: (document.documentElement.scrollHeight || document.body.scrollHeight) + 24 });
  }
  window.addEventListener("load", resize);
  if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(document.body); } catch(e) {} }

  var EDGES = data.edges || [];
  var WORKFLOW_ID = data.workflowId;
  var CUSTOM_AGENTS = [];

  // 状态识别：从服务端数据恢复批准凭据
  var isConsumed = Boolean(data.status === "consumed" || data.consumed === true);
  var isApproved = Boolean(data.status === "approved" || data.approvalGranted === true);
  var cachedEventPayload = null;
  if (isApproved && data.approvalEvent) {
    cachedEventPayload = readApprovalEvent(data.approvalEvent, data);
  }

  // Always forward the backend handoff intact. Never rebuild it from old defaults
  // or current DOM values; this path is shared by first approval and resend.
  function readApprovalEvent(event, credentials) {
    if (!event || event.schemaVersion !== 1 || event.workflowId !== WORKFLOW_ID
      || event.planHash !== credentials.planHash || event.submissionId !== credentials.submissionId
      || typeof event.instructions !== "string" || !Array.isArray(event.requiredToolCalls)
      || (!event.assignments && event.assignmentsOmitted !== true)) {
      throw new Error("批准回传缺少最终人员或读取指引，请刷新画布后重试。");
    }
    return event;
  }

  var svg = document.getElementById("svg-connections");
  var container = document.getElementById("dag-container");
  var selects = Array.prototype.slice.call(document.querySelectorAll(".agent-select"));
  var summaryEl = document.getElementById("route-summary");
  var btn = document.getElementById("btn-submit");
  var btnAddAgent = document.getElementById("btn-add-agent");
  var btnText = document.getElementById("btn-text");
  var badge = document.getElementById("status-badge");

  // 锁定配置防御：方案获批后必须禁用所有人员下拉与添加按钮，杜绝界面显示新专员却发送旧缓存指纹
  function lockConfiguration() {
    selects.forEach(function(s) {
      s.disabled = true;
      s.style.opacity = "0.75";
      s.style.cursor = "not-allowed";
    });
    if (btnAddAgent) {
      btnAddAgent.disabled = true;
      btnAddAgent.style.opacity = "0.5";
      btnAddAgent.style.cursor = "not-allowed";
    }
  }

  if (isApproved || isConsumed) {
    lockConfiguration();
  }

  // 动态绘制真实贝塞尔曲线 DAG 连线
  function drawDagEdges() {
    if (!svg || !container) return;
    var containerRect = container.getBoundingClientRect();
    var defs = svg.querySelector("defs") ? svg.querySelector("defs").outerHTML : "";
    var pathsHtml = defs;

    EDGES.forEach(function(edge) {
      var fromEl = document.getElementById("node-" + edge.from);
      var toEl = document.getElementById("node-" + edge.to);
      if (!fromEl || !toEl) return;

      var fromRect = fromEl.getBoundingClientRect();
      var toRect = toEl.getBoundingClientRect();

      var x1 = (fromRect.right - containerRect.left);
      var y1 = (fromRect.top + fromRect.height / 2 - containerRect.top);
      var x2 = (toRect.left - containerRect.left);
      var y2 = (toRect.top + toRect.height / 2 - containerRect.top);

      var dx = Math.max(30, (x2 - x1) / 2);
      var cx1 = x1 + dx;
      var cy1 = y1;
      var cx2 = x2 - dx;
      var cy2 = y2;

      var isConflict = edge.type === "conflict-serialized";
      var strokeColor = isConflict ? "var(--seal-vermilion)" : "var(--ink-secondary)";
      var strokeDash = isConflict ? "stroke-dasharray='4,4'" : "";
      var markerId = isConflict ? "url(#arrow-conflict)" : "url(#arrow)";

      pathsHtml += '<path d="M ' + x1 + ' ' + y1 + ' C ' + cx1 + ' ' + cy1 + ', ' + cx2 + ' ' + cy2 + ', ' + x2 + ' ' + y2 + '" '
        + 'fill="none" stroke="' + strokeColor + '" stroke-width="1.8" ' + strokeDash + ' marker-end="' + markerId + '" opacity="0.75" />';
    });

    svg.innerHTML = pathsHtml;
  }

  window.addEventListener("load", drawDagEdges);
  window.addEventListener("resize", drawDagEdges);
  setTimeout(drawDagEdges, 60);

  // 动态向所有下拉框注册新助手
  function registerCustomAgent(agentId, agentName) {
    if (isApproved || isConsumed) return null;
    if (!agentId || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      return null;
    }
    var displayName = agentName || agentId;
    var exists = CUSTOM_AGENTS.some(function(a) { return a.id === agentId; });
    if (!exists) {
      CUSTOM_AGENTS.push({ id: agentId, name: displayName, desc: "自定义指派专员" });
      selects.forEach(function(s) {
        var opt = document.createElement("option");
        opt.value = agentId;
        opt.textContent = displayName + " (" + agentId + ") [自定义专员]";
        var customGroup = s.querySelector("optgroup[label*='动态指派']");
        if (customGroup) {
          customGroup.insertBefore(opt, customGroup.firstChild);
        } else {
          s.appendChild(opt);
        }
      });
    }
    return agentId;
  }

  // 更新人员路线摘要并执行就绪守卫
  function updateSummary() {
    var hasUnassigned = false;
    var plan = selects.map(function(s) {
      var nid = s.dataset.nodeId;
      var val = s.value;
      if (!val || val === "__add_custom__") {
        hasUnassigned = true;
        return nid + " ➔ ⚠️ 未指定有效专员";
      }
      var selOpt = s.options[s.selectedIndex];
      var agentName = selOpt ? selOpt.text.split(" ")[0] : s.value;
      return nid + " ➔ " + agentName;
    });

    if (isConsumed) {
      summaryEl.textContent = "当前流水线已核销施工：" + plan.join(" | ");
      btn.disabled = true;
      btnText.textContent = "方案已核销施工";
      badge.textContent = "已消费执行";
      badge.className = "title-badge badge-status-done";
      return;
    }

    if (hasUnassigned && !isApproved) {
      summaryEl.innerHTML = "<span style='color:var(--seal-vermilion);font-weight:600;'>⚠️ 存在未指定或未授权专员，请在上方卡片中更换为有效专员后方可启动。</span>";
      btn.disabled = true;
      btnText.textContent = "请先指定所有有效专员";
    } else {
      summaryEl.textContent = "当前流水线配置 (已锁定)：" + plan.join(" | ");
      if (cachedEventPayload) {
        btn.disabled = false;
        btnText.textContent = "🚀 再次点击发送已批准方案";
        badge.textContent = "已获批准 (待回传)";
      } else if (!isApproved) {
        btn.disabled = false;
        btnText.textContent = "确认方案并批准";
      }
    }
  }

  // 内嵌模态框交互逻辑
  var modalBackdrop = document.getElementById("custom-modal-backdrop");
  var modalIdInput = document.getElementById("modal-agent-id");
  var modalNameInput = document.getElementById("modal-agent-name");
  var modalIdError = document.getElementById("modal-id-error");
  var modalBtnClose = document.getElementById("modal-btn-close");
  var modalBtnCancel = document.getElementById("modal-btn-cancel");
  var modalBtnConfirm = document.getElementById("modal-btn-confirm");
  var activeTriggerSelect = null;
  var previousSelectValue = null;

  function openCustomModal(triggerSelect) {
    if (isApproved || isConsumed) return;
    activeTriggerSelect = triggerSelect || null;
    previousSelectValue = triggerSelect ? (triggerSelect.dataset.lastValidValue || triggerSelect.options[0].value) : null;
    modalIdInput.value = "";
    modalNameInput.value = "";
    modalIdError.style.display = "none";
    modalBackdrop.classList.add("active");
    setTimeout(function() { modalIdInput.focus(); }, 60);
  }

  function closeCustomModal() {
    modalBackdrop.classList.remove("active");
    if (activeTriggerSelect && activeTriggerSelect.value === "__add_custom__") {
      activeTriggerSelect.value = previousSelectValue || activeTriggerSelect.options[0].value;
      updateSummary();
    }
    activeTriggerSelect = null;
  }

  // 纯 DOM 模态通知处理逻辑
  var alertBackdrop = document.getElementById("alert-modal-backdrop");
  var alertTitle = document.getElementById("alert-modal-title");
  var alertMsg = document.getElementById("alert-modal-msg");
  var alertIcon = document.getElementById("alert-modal-icon");
  var alertBtnClose = document.getElementById("alert-btn-close");
  var alertBtnConfirm = document.getElementById("alert-btn-confirm");

  function showAlertModal(message, title, icon) {
    if (alertTitle) alertTitle.textContent = title || "系统提示";
    if (alertIcon) alertIcon.textContent = icon || "⚠️";
    if (alertMsg) alertMsg.textContent = message || "";
    if (alertBackdrop) alertBackdrop.classList.add("active");
  }

  function closeAlertModal() {
    if (alertBackdrop) alertBackdrop.classList.remove("active");
  }

  if (alertBtnClose) alertBtnClose.addEventListener("click", closeAlertModal);
  if (alertBtnConfirm) alertBtnConfirm.addEventListener("click", closeAlertModal);
  if (alertBackdrop) {
    alertBackdrop.addEventListener("click", function(e) {
      if (e.target === alertBackdrop) closeAlertModal();
    });
  }

  if (modalBtnClose) modalBtnClose.addEventListener("click", closeCustomModal);
  if (modalBtnCancel) modalBtnCancel.addEventListener("click", closeCustomModal);
  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", function(e) {
      if (e.target === modalBackdrop) closeCustomModal();
    });
  }
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
      if (modalBackdrop && modalBackdrop.classList.contains("active")) {
        closeCustomModal();
      }
      if (alertBackdrop && alertBackdrop.classList.contains("active")) {
        closeAlertModal();
      }
    }
  });

  function handleConfirmCustomAgent() {
    var rawId = modalIdInput.value.trim();
    var rawName = modalNameInput.value.trim();

    if (!rawId || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) {
      modalIdError.style.display = "block";
      modalIdInput.focus();
      return;
    }

    var registeredId = registerCustomAgent(rawId, rawName || rawId);
    if (registeredId) {
      if (activeTriggerSelect) {
        activeTriggerSelect.value = registeredId;
        activeTriggerSelect.dataset.lastValidValue = registeredId;
      }
      updateSummary();
    }
    modalBackdrop.classList.remove("active");
    activeTriggerSelect = null;
  }

  if (modalBtnConfirm) modalBtnConfirm.addEventListener("click", handleConfirmCustomAgent);
  if (modalIdInput) {
    modalIdInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") handleConfirmCustomAgent();
    });
    modalIdInput.addEventListener("input", function() {
      modalIdError.style.display = "none";
    });
  }
  if (modalNameInput) {
    modalNameInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") handleConfirmCustomAgent();
    });
  }

  selects.forEach(function(s) {
    s.dataset.lastValidValue = s.value;
    s.addEventListener("change", function() {
      if (s.value === "__add_custom__") {
        openCustomModal(s);
      } else {
        s.dataset.lastValidValue = s.value;
        updateSummary();
      }
    });
  });
  updateSummary();

  if (btnAddAgent) {
    btnAddAgent.addEventListener("click", function() {
      openCustomModal(null);
    });
  }

  // 视口横向滚动与拖拽
  var viewportEl = document.getElementById("dag-viewport");
  var btnScrollL = document.getElementById("scroll-btn-left");
  var btnScrollR = document.getElementById("scroll-btn-right");

  if (viewportEl && btnScrollL && btnScrollR) {
    function updateViewportScrollButtons() {
      var atLeft = viewportEl.scrollLeft <= 5;
      var atRight = viewportEl.scrollLeft + viewportEl.clientWidth >= viewportEl.scrollWidth - 8;
      btnScrollL.style.opacity = atLeft ? "0.25" : "0.95";
      btnScrollL.style.pointerEvents = atLeft ? "none" : "auto";
      btnScrollR.style.opacity = atRight ? "0.25" : "0.95";
      btnScrollR.style.pointerEvents = atRight ? "none" : "auto";
    }

    btnScrollL.addEventListener("click", function(e) {
      e.stopPropagation();
      viewportEl.scrollBy({ left: -220, behavior: "smooth" });
    });
    btnScrollR.addEventListener("click", function(e) {
      e.stopPropagation();
      viewportEl.scrollBy({ left: 220, behavior: "smooth" });
    });

    viewportEl.addEventListener("scroll", updateViewportScrollButtons);
    window.addEventListener("resize", updateViewportScrollButtons);
    setTimeout(updateViewportScrollButtons, 80);

    viewportEl.addEventListener("wheel", function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        viewportEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    var isViewportDragging = false;
    var dragStartX = 0;
    var dragScrollLeft = 0;

    viewportEl.addEventListener("mousedown", function(e) {
      if (e.target.tagName === "SELECT" || e.target.tagName === "OPTION" || e.target.tagName === "BUTTON") return;
      isViewportDragging = true;
      viewportEl.classList.add("is-dragging");
      dragStartX = e.pageX - viewportEl.offsetLeft;
      dragScrollLeft = viewportEl.scrollLeft;
    });

    window.addEventListener("mouseup", function() {
      if (isViewportDragging) {
        isViewportDragging = false;
        viewportEl.classList.remove("is-dragging");
      }
    });

    viewportEl.addEventListener("mousemove", function(e) {
      if (!isViewportDragging) return;
      e.preventDefault();
      var curX = e.pageX - viewportEl.offsetLeft;
      var dist = (curX - dragStartX) * 1.4;
      viewportEl.scrollLeft = dragScrollLeft - dist;
    });
  }

  /**
   * 触发宿主事件投递
   * 严格契约：
   * 1. 若宿主无可用接口，绝不伪造成功，必须返回明确的 requires_host 拒绝；
   * 2. 若使用 hana.emit：严格只认可 res && res.delivered === true；
   * 3. 若使用 window.card.emit：严格只认可 res && res.ok === true；
   * 4. 无 to 参数，由宿主路由；delivered 仅表示宿主接受投递，不表示执行完成。
   */
  function dispatchHostEmit(payload) {
    if (typeof hana.emit === "function") {
      return Promise.resolve(hana.emit("workflow.approved", payload)).then(function(res) {
        if (res && res.delivered === true) {
          return { success: true, delivered: true };
        }
        return { success: false, delivered: false, error: "host_not_delivered", message: "宿主未确认接收事件" };
      });
    }

    if (window.card && typeof window.card.emit === "function") {
      return Promise.resolve(window.card.emit("workflow.approved", payload)).then(function(res) {
        if (res && res.ok === true) {
          return { success: true, delivered: true };
        }
        return { success: false, delivered: false, error: "card_emit_not_ok", message: "卡片总线回传未收到成功确认" };
      });
    }

    // 绝对禁止伪造成功！若宿主 bridge 缺失，直接拒绝并说明原因
    return Promise.reject(new Error("requires_host: 未检测到宿主回传环境 (hana.emit 或 window.card.emit 不可用)"));
  }

  // 提交与发令处理
  var isSubmitting = false;

  btn.addEventListener("click", function() {
    if (isConsumed || isSubmitting) return;

    // 【关键手势保障路径】：如果已有已批准并持久化的凭证，立刻在当前用户手势同步时刻调用 emit
    if (cachedEventPayload) {
      btnText.textContent = "正在回传最终分工...";
      btn.disabled = true;
      isSubmitting = true;

      // 锁定配置，防止换人发送旧方案
      lockConfiguration();

      var emitPromise = dispatchHostEmit(cachedEventPayload);

      Promise.resolve(emitPromise)
        .then(function(res) {
          isSubmitting = false;
          btn.disabled = false;
          if (res && res.success === true) {
            btnText.textContent = "已发送最终分工 (点击可重发)";
            badge.textContent = "已回传宿主路由";
            badge.className = "title-badge badge-status-done";
          } else {
            btnText.textContent = "🚀 再次点击发送已批准方案";
            showAlertModal("宿主尚未确认接收事件，请再次点击重发。", "投递未完成", "⚠️");
          }
        })
        .catch(function(err) {
          isSubmitting = false;
          btn.disabled = false;
          btnText.textContent = "🚀 再次点击发送已批准方案";
          showAlertModal("回传受阻: " + (err && err.message ? err.message : err), "投递受阻", "⚠️");
        });
      return;
    }

    // Older already-approved markup may contain only the three legacy IDs.
    // Recover the handoff from verified storage rather than posting DOM choices.
    if (isApproved) {
      isSubmitting = true;
      btn.disabled = true;
      hana.api.fetch("workflow/" + encodeURIComponent(WORKFLOW_ID) + "/approval")
        .then(function(res) {
          if (!res.ok) throw new Error("读取批准方案失败 (" + res.status + ")");
          return res.json();
        })
        .then(function(result) {
          var approved = result && result.data;
          if (!result.ok || !approved || approved.approved !== true || approved.hashMismatch) {
            throw new Error("后台批准方案未通过校验");
          }
          cachedEventPayload = readApprovalEvent(approved.approvalEvent, approved);
          isConsumed = Boolean(approved.consumed);
          btnText.textContent = "🚀 再次点击发送已批准方案";
          updateSummary();
        })
        .catch(function(err) {
          showAlertModal(err.message, "读取批准方案受阻", "⚠️");
        })
        .finally(function() {
          isSubmitting = false;
          btn.disabled = isConsumed;
        });
      return;
    }

    // 【首次登记与批准路径】：向认证 UI API 登记，持久化凭据
    isSubmitting = true;
    btn.disabled = true;
    btnText.textContent = "正在登记批准并计算方案指纹...";

    var assignments = {};
    selects.forEach(function(s) {
      assignments[s.dataset.nodeId] = s.value;
    });

    hana.api.fetch("workflow/" + encodeURIComponent(WORKFLOW_ID) + "/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: assignments,
        customAgents: CUSTOM_AGENTS
      })
    })
    .then(function(res) {
      return res.json().then(function(json) {
        return { status: res.status, ok: res.ok, data: json };
      }).catch(function() {
        return { status: res.status, ok: false, data: { message: "解析响应失败" } };
      });
    })
    .then(function(result) {
      if (result.ok && result.data && result.data.ok) {
        isApproved = true;
        lockConfiguration(); // 方案获批后立刻锁定所有人员选择框

        cachedEventPayload = readApprovalEvent(result.data.approvalEvent, result.data);

        // 尝试一次当前 emit
        var tryEmit = dispatchHostEmit(cachedEventPayload);
        Promise.resolve(tryEmit).then(function(res) {
          isSubmitting = false;
          btn.disabled = false;
          if (res && res.success === true) {
            btnText.textContent = "已发送最终分工 (点击可重发)";
            badge.textContent = "已回传宿主路由";
            badge.className = "title-badge badge-status-done";
          } else {
            btnText.textContent = "🚀 再次点击发送已批准方案";
            badge.textContent = "方案已核准待发送";
          }
        }).catch(function() {
          isSubmitting = false;
          btn.disabled = false;
          btnText.textContent = "🚀 再次点击发送已批准方案";
          badge.textContent = "方案已核准待发送";
        });
      } else {
        isSubmitting = false;
        btn.disabled = false;
        var errMsg = (result.data && (result.data.message || result.data.error)) || "提交受阻";
        btnText.textContent = "确认方案并批准";
        showAlertModal("方案登记未完成: " + errMsg, "审批未通过", "⚠️");
      }
    })
    .catch(function(err) {
      isSubmitting = false;
      btn.disabled = false;
      btnText.textContent = "重新尝试登记批准";
      showAlertModal((isApproved ? "方案已保存，最终分工尚未回传，请刷新后重试: " : "方案登记或响应失败，请重试: ") + (err && err.message ? err.message : err), "回传未完成", "⚠️");
    });
  });

  resize();
}
