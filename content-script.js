(() => {
  if (window.__querySnapContentScriptInstalled) {
    return;
  }

  window.__querySnapContentScriptInstalled = true;

  const MIN_SELECTION_SIZE = 8;
  const OVERLAY_ID = "querysnap-capture-overlay";
  const BOX_ID = "querysnap-capture-box";
  const TIP_ID = "querysnap-capture-tip";
  const FLOATING_HOST_ID = "querysnap-floating-host";
  const DEBUG = true;

  let isSelecting = false;
  let dragStart = null;
  let overlay = null;
  let selectionBox = null;
  let floatingHost = null;
  let floatingStatus = null;

  mountFloatingWindow();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.querySnapLatestJob) {
      return;
    }

    renderFloatingJob(changes.querySnapLatestJob.newValue);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "START_REGION_SELECTION") {
      return false;
    }

    startSelectionMode();
    sendResponse({ ok: true });
    return false;
  });

  function startSelectionMode() {
    stopSelectionMode();

    isSelecting = true;
    overlay = createOverlay();
    selectionBox = createSelectionBox();

    overlay.appendChild(createTip());
    overlay.appendChild(selectionBox);
    document.documentElement.appendChild(overlay);

    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("keydown", handleKeyDown, true);

    debugLog("selection mode started");
  }

  function stopSelectionMode() {
    isSelecting = false;
    dragStart = null;

    document.removeEventListener("mousedown", handleMouseDown, true);
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("mouseup", handleMouseUp, true);
    document.removeEventListener("keydown", handleKeyDown, true);

    overlay?.remove();
    overlay = null;
    selectionBox = null;
  }

  function handleMouseDown(event) {
    if (!isSelecting || event.button !== 0) {
      return;
    }

    dragStart = {
      x: event.clientX,
      y: event.clientY
    };

    updateSelectionBox(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleMouseMove(event) {
    if (!dragStart || !selectionBox) {
      return;
    }

    updateSelectionBox(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleMouseUp(event) {
    if (!dragStart) {
      return;
    }

    const region = buildRegion(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
    stopSelectionMode();

    if (region.width < MIN_SELECTION_SIZE || region.height < MIN_SELECTION_SIZE) {
      sendSelectionCancelled("框选区域太小，请重新选择。");
      return;
    }

    sendSelectedRegion(region);
  }

  function handleKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopSelectionMode();
    sendSelectionCancelled("已取消框选。");
  }

  function createOverlay() {
    const element = document.createElement("div");
    element.id = OVERLAY_ID;
    element.style.position = "fixed";
    element.style.inset = "0";
    element.style.zIndex = "2147483647";
    element.style.cursor = "crosshair";
    element.style.background = "rgba(15, 23, 42, 0.12)";
    element.style.userSelect = "none";
    return element;
  }

  function createTip() {
    const element = document.createElement("div");
    element.id = TIP_ID;
    element.textContent = "拖动选择截图区域，按 Esc 取消";
    element.style.position = "fixed";
    element.style.top = "16px";
    element.style.left = "50%";
    element.style.transform = "translateX(-50%)";
    element.style.padding = "8px 12px";
    element.style.borderRadius = "6px";
    element.style.background = "#111827";
    element.style.color = "#ffffff";
    element.style.font = "13px Arial, sans-serif";
    element.style.pointerEvents = "none";
    return element;
  }

  function createSelectionBox() {
    const element = document.createElement("div");
    element.id = BOX_ID;
    element.style.position = "fixed";
    element.style.display = "none";
    element.style.border = "2px solid #2563eb";
    element.style.background = "rgba(37, 99, 235, 0.18)";
    element.style.boxSizing = "border-box";
    element.style.pointerEvents = "none";
    return element;
  }

  function updateSelectionBox(currentX, currentY) {
    const left = Math.min(dragStart.x, currentX);
    const top = Math.min(dragStart.y, currentY);
    const width = Math.abs(currentX - dragStart.x);
    const height = Math.abs(currentY - dragStart.y);

    selectionBox.style.display = "block";
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
  }

  function buildRegion(currentX, currentY) {
    const x = Math.min(dragStart.x, currentX);
    const y = Math.min(dragStart.y, currentY);
    const width = Math.abs(currentX - dragStart.x);
    const height = Math.abs(currentY - dragStart.y);

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      devicePixelRatio: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageUrl: window.location.href,
      pageTitle: document.title
    };
  }

  function sendSelectedRegion(region) {
    chrome.runtime.sendMessage({
      type: "CAPTURE_REGION_SELECTED",
      payload: { region }
    }, (response) => {
      if (chrome.runtime.lastError) {
        debugError("failed to send selected region", chrome.runtime.lastError.message);
        return;
      }

      if (!response?.ok) {
        debugError("background rejected selected region", response?.error || "Unknown error");
        return;
      }

      debugLog("selected region sent", region);
    });
  }

  function sendSelectionCancelled(reason) {
    chrome.runtime.sendMessage({
      type: "CAPTURE_REGION_CANCELLED",
      payload: { reason }
    });
  }

  function mountFloatingWindow() {
    if (document.getElementById(FLOATING_HOST_ID)) {
      return;
    }

    floatingHost = document.createElement("div");
    floatingHost.id = FLOATING_HOST_ID;
    document.documentElement.appendChild(floatingHost);

    const shadow = floatingHost.attachShadow({ mode: "open" });
    shadow.appendChild(createFloatingStyle());

    // FAB button — visible when collapsed
    const fab = document.createElement("button");
    fab.className = "qs-fab";
    fab.textContent = "Q";
    fab.type = "button";
    fab.setAttribute("aria-label", "打开 QuerySnap");
    shadow.appendChild(fab);

    // Panel — hidden initially (qs-collapsed)
    const panel = document.createElement("section");
    panel.className = "qs-panel qs-collapsed";
    panel.innerHTML = `
      <header class="qs-header">
        <div>
          <strong>QuerySnap</strong>
          <span>复制文字或框选截图提问</span>
        </div>
        <div class="qs-header-actions">
          <button class="qs-icon-button qs-toggle" type="button" aria-label="收起">−</button>
          <button class="qs-icon-button qs-close" type="button" aria-label="关闭">×</button>
        </div>
      </header>
      <div class="qs-body">
        <textarea class="qs-input" rows="3" placeholder="输入问题，使用当前插件配置的 API 和模型"></textarea>
        <div class="qs-actions">
          <button class="qs-submit qs-text-submit" type="button">复制文字提问</button>
          <button class="qs-submit qs-shot-submit" type="button">截图提问</button>
        </div>
        <div class="qs-status">等待提问。</div>
      </div>
    `;

    shadow.appendChild(panel);

    const header = panel.querySelector(".qs-header");
    const closeButton = panel.querySelector(".qs-close");
    const toggleButton = panel.querySelector(".qs-toggle");
    const textSubmitButton = panel.querySelector(".qs-text-submit");
    const screenshotSubmitButton = panel.querySelector(".qs-shot-submit");
    const input = panel.querySelector(".qs-input");
    floatingStatus = panel.querySelector(".qs-status");

    // Click FAB → expand panel
    fab.addEventListener("click", () => {
      fab.style.display = "none";
      panel.classList.remove("qs-collapsed");
      toggleButton.textContent = "−";
      toggleButton.setAttribute("aria-label", "收起");
    });

    closeButton.addEventListener("click", () => {
      floatingHost.remove();
      floatingHost = null;
      floatingStatus = null;
    });

    // Toggle "−" → collapse back to FAB
    toggleButton.addEventListener("click", () => {
      panel.classList.add("qs-collapsed");
      fab.style.display = "";
      toggleButton.textContent = "−";
      toggleButton.setAttribute("aria-label", "收起");
    });

    textSubmitButton.addEventListener("click", () => {
      askTextFromFloatingWindow(input, textSubmitButton, screenshotSubmitButton);
    });

    screenshotSubmitButton.addEventListener("click", () => {
      askScreenshotFromFloatingWindow(input, textSubmitButton, screenshotSubmitButton);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        askTextFromFloatingWindow(input, textSubmitButton, screenshotSubmitButton);
      }
    });

    makeFloatingWindowDraggable(panel, header, fab);
  }

  function createFloatingStyle() {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 2147483646;
        font-family: Arial, "Microsoft YaHei", sans-serif;
      }

      .qs-panel {
        width: 320px;
        max-width: calc(100vw - 36px);
        border: 1px solid #d7dee8;
        border-radius: 8px;
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.18);
        background: #ffffff;
        color: #15202b;
        overflow: hidden;
      }

      .qs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        background: #f5f7fa;
        border-bottom: 1px solid #e3e8ef;
        cursor: move;
        user-select: none;
      }

      .qs-header strong {
        display: block;
        font-size: 14px;
        line-height: 1.2;
      }

      .qs-header span {
        display: block;
        margin-top: 2px;
        color: #637083;
        font-size: 12px;
      }

      .qs-icon-button {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 6px;
        background: #e8edf4;
        color: #15202b;
        font: 18px/1 Arial, sans-serif;
        cursor: pointer;
      }

      .qs-header-actions {
        display: flex;
        gap: 6px;
      }

      .qs-collapsed {
        display: none;
      }

      .qs-fab {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: none;
        background: #2563eb;
        color: #ffffff;
        font-size: 24px;
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
      }

      .qs-fab:hover {
        box-shadow: 0 6px 20px rgba(37, 99, 235, 0.55);
      }

      .qs-input {
        display: block;
        width: calc(100% - 24px);
        min-height: 78px;
        margin: 12px;
        border: 1px solid #cfd8e3;
        border-radius: 6px;
        padding: 9px 10px;
        resize: vertical;
        color: #15202b;
        background: #ffffff;
        font: 13px/1.45 Arial, "Microsoft YaHei", sans-serif;
        box-sizing: border-box;
      }

      .qs-input:focus {
        border-color: #2563eb;
        outline: 2px solid rgba(37, 99, 235, 0.16);
      }

      .qs-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 0 12px 12px;
      }

      .qs-submit {
        min-height: 32px;
        border: 0;
        border-radius: 6px;
        padding: 0 12px;
        background: #2563eb;
        color: #ffffff;
        font: 700 13px Arial, "Microsoft YaHei", sans-serif;
        cursor: pointer;
      }

      .qs-submit:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }

      .qs-shot-submit {
        background: #0f766e;
      }

      .qs-status {
        max-height: 220px;
        overflow: auto;
        border-top: 1px solid #e3e8ef;
        padding: 10px 12px;
        background: #fbfcfe;
        color: #475569;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.5 Arial, "Microsoft YaHei", sans-serif;
      }

      .qs-status.qs-error {
        color: #b42318;
      }
    `;

    return style;
  }

  function askTextFromFloatingWindow(input, textButton, screenshotButton) {
    const question = input.value.trim();
    if (!question) {
      updateFloatingStatus("请先输入问题。", true);
      input.focus();
      return;
    }

    updateFloatingStatus("正在请求...");
    setFloatingBusy(textButton, screenshotButton, true);

    chrome.runtime.sendMessage({
      type: "ASK_FLOATING_TEXT_QUESTION",
      payload: {
        question,
        textContext: window.getSelection()?.toString().trim() || ""
      }
    }, (response) => {
      setFloatingBusy(textButton, screenshotButton, false);

      if (chrome.runtime.lastError) {
        updateFloatingStatus(chrome.runtime.lastError.message, true);
        return;
      }

      if (!response?.ok) {
        updateFloatingStatus(response?.error || "AI 请求失败。", true);
        return;
      }

      updateFloatingStatus(response.answer || "AI 没有返回内容。");
    });
  }

  function askScreenshotFromFloatingWindow(input, textButton, screenshotButton) {
    const question = input.value.trim();

    updateFloatingStatus("正在准备截图框选...");
    setFloatingBusy(textButton, screenshotButton, true);

    chrome.runtime.sendMessage({
      type: "START_FLOATING_SCREENSHOT_QUESTION",
      payload: {
        question,
        textContext: window.getSelection()?.toString().trim() || ""
      }
    }, (response) => {
      setFloatingBusy(textButton, screenshotButton, false);

      if (chrome.runtime.lastError) {
        updateFloatingStatus(chrome.runtime.lastError.message, true);
        return;
      }

      if (!response?.ok) {
        updateFloatingStatus(response?.error || "无法启动截图提问。", true);
        return;
      }

      updateFloatingStatus("请在页面上拖动框选截图区域。图片会直接发送给大模型分析。");
    });
  }

  function setFloatingBusy(textButton, screenshotButton, isBusy) {
    textButton.disabled = isBusy;
    screenshotButton.disabled = isBusy;
  }

  function renderFloatingJob(job) {
    if (!floatingStatus || !job) {
      return;
    }

    if (job.status === "error") {
      updateFloatingStatus(job.error || "请求失败。", true);
      return;
    }

    if (job.answer) {
      updateFloatingStatus(job.answer);
      return;
    }

    updateFloatingStatus(job.message || "正在处理...");
  }

  function updateFloatingStatus(message, isError = false) {
    if (!floatingStatus) {
      return;
    }

    floatingStatus.classList.toggle("qs-error", isError);
    floatingStatus.textContent = message;
  }

  function makeFloatingWindowDraggable(panel, handle, fabHandle) {
    let drag = null;

    function onDragStart(event) {
      if (event.button !== 0) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top
      };

      event.preventDefault();
    }

    handle.addEventListener("mousedown", onDragStart);
    if (fabHandle) {
      fabHandle.addEventListener("mousedown", onDragStart);
    }

    window.addEventListener("mousemove", (event) => {
      if (!drag || !floatingHost) {
        return;
      }

      const nextLeft = clamp(drag.left + event.clientX - drag.startX, 8, window.innerWidth - panel.offsetWidth - 8);
      const nextTop = clamp(drag.top + event.clientY - drag.startY, 8, window.innerHeight - panel.offsetHeight - 8);

      floatingHost.style.left = `${nextLeft}px`;
      floatingHost.style.top = `${nextTop}px`;
      floatingHost.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      drag = null;
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function debugLog(message, details) {
    if (!DEBUG) {
      return;
    }

    console.log(`[QuerySnap content] ${message}`, details ?? "");
  }

  function debugError(message, error) {
    console.error(`[QuerySnap content] ${message}`, error);
  }
})();
