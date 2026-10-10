export function initializeWorkflow(data, hana) {
    function resize() {
      hana.ui.resize({ height: (document.documentElement.scrollHeight || document.body.scrollHeight) + 24 });
    }
    window.addEventListener("load", resize);
    if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(document.body); } catch(e) {} }

    var EDGES = data.edges;
    var WORKFLOW_ID = data.workflowId;
    var ALREADY_DONE = data.alreadyDone;
    var CUSTOM_AGENTS = [];

    var svg = document.getElementById("svg-connections");
    var container = document.getElementById("dag-container");
    var selects = Array.prototype.slice.call(document.querySelectorAll(".agent-select"));
    var summaryEl = document.getElementById("route-summary");
    var btn = document.getElementById("btn-submit");
    var btnAddAgent = document.getElementById("btn-add-agent");
    var btnText = document.getElementById("btn-text");
    var badge = document.getElementById("status-badge");

    // 动态绘制真实贝塞尔曲线 DAG 连线
    function drawDagEdges() {
      var containerRect = container.getBoundingClientRect();
      var defs = svg.querySelector("defs").outerHTML;
      var pathsHtml = defs;

      EDGES.forEach(function(edge) {
        var fromEl = document.getElementById("node-" + edge.from);
        var toEl = document.getElementById("node-" + edge.to);
        if (!fromEl || !toEl) return;

        var fromRect = fromEl.getBoundingClientRect();
        var toRect = toEl.getBoundingClientRect();

        // 起点位于源卡片右中，终点位于目标卡片左中
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
          // 插入到最前面的选项中
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

      if (hasUnassigned && !ALREADY_DONE) {
        summaryEl.innerHTML = "<span style='color:var(--seal-vermilion);font-weight:600;'>⚠️ 存在未指定或未授权专员，请在上方卡片中更换为有效专员后方可启动。</span>";
        btn.disabled = true;
        btnText.textContent = "请先指定所有有效专员";
      } else {
        summaryEl.textContent = "当前流水线配置：" + plan.join(" | ");
        if (!ALREADY_DONE) {
          btn.disabled = false;
          btnText.textContent = "确认方案 · 启动全链路调度";
        }
      }
    }

    // 内嵌模态框交互逻辑 (纯 DOM，杜绝 prompt 拦截失效)
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

    // 纯 DOM 模态通知处理逻辑 (杜绝 alert / prompt)
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

    // 画布左右滑动控制与抓手拖拽系统
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

      // 滚轮直接转换为横向滚动
      viewportEl.addEventListener("wheel", function(e) {
        if (e.deltaY !== 0) {
          e.preventDefault();
          viewportEl.scrollLeft += e.deltaY;
        }
      }, { passive: false });

      // 鼠标按住抓手拖拽 (Drag to Scroll)
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

    // 提交调度执行
    var isSubmitting = false;
    btn.addEventListener("click", function() {
      if (ALREADY_DONE || isSubmitting) return;

      isSubmitting = true;
      btn.disabled = true;
      btnText.textContent = "正在等待宿主 Bus 应答...";

      var assignments = {};
      selects.forEach(function(s) {
        assignments[s.dataset.nodeId] = s.value;
      });

      hana.api.fetch("workflow/" + encodeURIComponent(WORKFLOW_ID) + "/execute", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
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
        isSubmitting = false;
        if (result.ok && result.data && result.data.ok) {
          ALREADY_DONE = true;
          btnText.textContent = "已成功交接宿主调度总线";
          badge.textContent = "已投递调度 Bus";
          badge.className = "title-badge badge-status-done";
        } else {
          var errMsg = (result.data && (result.data.message || result.data.error)) || "网络异常";
          var isDeliveryUnknown = result.data && result.data.error === "delivery_unknown";
          var locked = [409,423,504].indexOf(result.status) >= 0 || (result.status === 502 && isDeliveryUnknown) || isDeliveryUnknown || !result.data || !result.data.error;
          if (locked) ALREADY_DONE = true;
          btn.disabled = locked;
          btnText.textContent = locked ? "送达状态未决，请核实主会话" : "重新提交计划";
          showAlertModal("计划未确认提交: " + errMsg, "提交未完成", "⚠️");
        }
      })
      .catch(function(err) {
        isSubmitting = false;
        ALREADY_DONE = true;
        btn.disabled = true;
        btnText.textContent = "送达状态不明，请核实主会话";
        showAlertModal("网络请求未得到确认，请先核实主会话，勿重复提交: " + (err && err.message ? err.message : err), "投递状态未决", "🔒");
      });
    });

    resize();

}
