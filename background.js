const STORAGE_KEYS = {
  apiConfigs: "querySnapApiConfigs",
  selectedApiId: "querySnapSelectedApiId",
  selectedModelByApi: "querySnapSelectedModelByApi",
  latestJob: "querySnapLatestJob"
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_SCREENSHOT_PROMPT = "请仔细分析这张截图，说明其中的主要内容、关键信息、可能的含义，并在有必要时给出可执行的建议。";
const MAX_IMAGE_DIMENSION = 1600;
const JPEG_QUALITY = 0.88;
const DEBUG = true;

const pendingScreenshotJobs = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("message received", {
    type: message?.type,
    tabId: sender.tab?.id ?? message?.payload?.tabId ?? null
  });

  if (message?.type === "FETCH_MODELS") {
    fetchModelsForConfig(message.payload?.apiConfigId)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "START_SCREENSHOT_QUESTION") {
    startScreenshotQuestion(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "CAPTURE_REGION_SELECTED") {
    handleCaptureRegionSelected(sender.tab, message.payload?.region)
      .catch((error) => failLatestJob(error));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "CAPTURE_REGION_CANCELLED") {
    if (sender.tab?.id) {
      pendingScreenshotJobs.delete(sender.tab.id);
    }

    failLatestJob(new Error(message.payload?.reason || "已取消框选。"));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "ASK_TEXT_QUESTION") {
    askTextQuestion(message.payload)
      .then((answer) => sendResponse({ ok: true, answer }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "ASK_FLOATING_TEXT_QUESTION") {
    askFloatingTextQuestion(message.payload)
      .then((answer) => sendResponse({ ok: true, answer }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message?.type === "START_FLOATING_SCREENSHOT_QUESTION") {
    startFloatingScreenshotQuestion(sender.tab, message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  return false;
});

async function fetchModelsForConfig(apiConfigId) {
  const config = await getApiConfigById(apiConfigId);
  assertApiConfigReady(config, { requireModel: false });
  validateUrl(config.modelsUrl, "模型列表接口 URL");

  debugLog("fetching model list", {
    api: config.name,
    modelsUrl: config.modelsUrl
  });

  let response;
  try {
    response = await fetch(config.modelsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Accept": "application/json"
      }
    });
  } catch (error) {
    throw new Error(`模型列表请求失败：${getErrorMessage(error)}`);
  }

  const rawText = await response.text().catch(() => "");
  const data = parseJsonResponse(rawText, "模型列表接口");

  if (!response.ok) {
    const message = data?.error?.message ||
      data?.message ||
      `模型列表请求失败，HTTP 状态码：${response.status}${rawText ? `，响应：${truncate(rawText)}` : ""}`;
    throw new Error(message);
  }

  const models = parseModelList(data);
  if (!models.length) {
    throw new Error(`模型列表为空，或接口返回格式无法识别。响应：${truncate(rawText)}`);
  }

  return models;
}

async function startScreenshotQuestion(payload) {
  const tabId = payload?.tabId;
  const question = payload?.question?.trim() || DEFAULT_SCREENSHOT_PROMPT;
  const model = payload?.model?.trim();
  const config = await getApiConfigById(payload?.apiConfigId);

  if (!tabId) {
    throw new Error("没有找到当前标签页。");
  }

  assertApiConfigReady(config, { model });

  pendingScreenshotJobs.set(tabId, {
    question,
    textContext: payload?.textContext?.trim() || "",
    apiConfigId: config.id,
    model,
    createdAt: Date.now()
  });

  await setLatestJob({
    status: "waiting_selection",
    message: "等待框选截图区域。",
    answer: "",
    apiName: config.name,
    model
  });

  try {
    await sendMessageToTabWithInjection(tabId, { type: "START_REGION_SELECTION" });
  } catch (error) {
    pendingScreenshotJobs.delete(tabId);
    throw error;
  }
}

async function handleCaptureRegionSelected(tab, region) {
  if (!tab?.id || !tab.windowId) {
    throw new Error("无法确定截图所在的标签页。");
  }

  const job = pendingScreenshotJobs.get(tab.id);
  if (!job) {
    throw new Error("没有待处理的截图提问任务，请从 popup 重新开始。");
  }

  if (!isValidRegion(region)) {
    throw new Error("没有有效的框选区域。");
  }

  pendingScreenshotJobs.delete(tab.id);
  const config = await getApiConfigById(job.apiConfigId);
  assertApiConfigReady(config, { model: job.model });

  await setLatestJob({
    status: "capturing",
    message: "正在截图...",
    apiName: config.name,
    model: job.model
  });

  const visibleTabDataUrl = await captureVisibleTab(tab.windowId);

  await setLatestJob({
    status: "cropping",
    message: "正在裁剪图片...",
    apiName: config.name,
    model: job.model
  });

  const croppedImageDataUrl = await cropImageDataUrl(visibleTabDataUrl, region);

  await setLatestJob({
    status: "requesting",
    message: "正在请求 AI...",
    apiName: config.name,
    model: job.model
  });

  const answer = await callOpenAICompatibleApi({
    config,
    model: job.model,
    question: job.question,
    textContext: job.textContext,
    imageDataUrl: croppedImageDataUrl
  });

  await setLatestJob({
    status: "done",
    message: "请求完成。",
    answer,
    region,
    pageUrl: region.pageUrl,
    pageTitle: region.pageTitle,
    apiName: config.name,
    model: job.model,
    updatedAt: Date.now()
  });
}

async function askTextQuestion(payload) {
  const question = payload?.question?.trim();
  const model = payload?.model?.trim();
  const config = await getApiConfigById(payload?.apiConfigId);

  if (!question) {
    throw new Error("请先输入问题。");
  }

  assertApiConfigReady(config, { model });

  await setLatestJob({
    status: "requesting",
    message: "正在请求 AI...",
    answer: "",
    apiName: config.name,
    model
  });

  const answer = await callOpenAICompatibleApi({
    config,
    model,
    question,
    textContext: payload?.textContext?.trim() || "",
    imageDataUrl: ""
  });

  await setLatestJob({
    status: "done",
    message: "请求完成。",
    answer,
    apiName: config.name,
    model,
    updatedAt: Date.now()
  });

  return answer;
}

async function askFloatingTextQuestion(payload) {
  const question = payload?.question?.trim();
  if (!question) {
    throw new Error("请先输入问题。");
  }

  const { apiConfigId, model } = await getSelectedApiAndModel();

  return askTextQuestion({
    question,
    textContext: payload?.textContext?.trim() || "",
    apiConfigId,
    model
  });
}

async function startFloatingScreenshotQuestion(tab, payload) {
  const question = payload?.question?.trim() || DEFAULT_SCREENSHOT_PROMPT;

  if (!tab?.id) {
    throw new Error("无法确定当前网页标签页。");
  }

  const { apiConfigId, model } = await getSelectedApiAndModel();

  await startScreenshotQuestion({
    tabId: tab.id,
    question,
    textContext: payload?.textContext?.trim() || "",
    apiConfigId,
    model
  });
}

async function callOpenAICompatibleApi({ config, model, question, textContext, imageDataUrl }) {
  const endpoint = buildRequestEndpoint(config);
  validateUrl(endpoint, "API 请求 URL");

  debugLog("sending API request", {
    api: config.name,
    endpoint,
    model,
    requestType: config.requestType,
    hasImage: Boolean(imageDataUrl)
  });

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildRequestBody({
        requestType: config.requestType,
        model,
        question,
        textContext,
        imageDataUrl
      }))
    });
  } catch (error) {
    throw new Error(`API 网络请求失败：${getErrorMessage(error)}`);
  }

  const rawText = await response.text().catch(() => "");
  const data = parseApiResponse(rawText, "AI 请求接口");

  if (!response.ok) {
    const message = data?.error?.message ||
      data?.message ||
      `API 请求失败，HTTP 状态码：${response.status}${rawText ? `，响应：${truncate(rawText)}` : ""}`;
    throw new Error(message);
  }

  return extractResponseText(data);
}

function buildPromptText(question, textContext) {
  return [
    "请根据用户的问题回答。如果提供了截图图片，请直接分析消息中附带的图片内容，不要尝试调用外部 OCR、文件读取或 URL 抓取工具。",
    textContext ? `用户粘贴的文字上下文：\n${textContext}` : "",
    `用户问题：${question}`
  ].filter(Boolean).join("\n\n");
}

async function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`截图失败：${chrome.runtime.lastError.message}`));
        return;
      }

      if (!dataUrl) {
        reject(new Error("截图失败：浏览器没有返回截图数据。"));
        return;
      }

      resolve(dataUrl);
    });
  });
}

async function cropImageDataUrl(sourceDataUrl, region) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("图片裁剪失败：当前浏览器不支持 OffscreenCanvas。");
  }

  try {
    const imageResponse = await fetch(sourceDataUrl);
    const imageBlob = await imageResponse.blob();
    const bitmap = await createImageBitmap(imageBlob);
    const scale = Number(region.devicePixelRatio) || 1;

    const sx = clamp(Math.round(region.x * scale), 0, bitmap.width);
    const sy = clamp(Math.round(region.y * scale), 0, bitmap.height);
    const sw = clamp(Math.round(region.width * scale), 1, bitmap.width - sx);
    const sh = clamp(Math.round(region.height * scale), 1, bitmap.height - sy);

    if (sw <= 0 || sh <= 0) {
      throw new Error("裁剪区域超出截图范围。");
    }

    const { targetWidth, targetHeight } = calculateTargetImageSize(sw, sh);
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("无法创建 canvas 2D 上下文。");
    }

    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
    bitmap.close?.();

    const croppedBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: JPEG_QUALITY
    });

    return blobToDataUrl(croppedBlob);
  } catch (error) {
    throw new Error(`图片裁剪失败：${getErrorMessage(error)}`);
  }
}

function calculateTargetImageSize(width, height) {
  const maxSide = Math.max(width, height);
  if (maxSide <= MAX_IMAGE_DIMENSION) {
    return {
      targetWidth: width,
      targetHeight: height
    };
  }

  const scale = MAX_IMAGE_DIMENSION / maxSide;
  return {
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale))
  };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

async function getApiConfigById(apiConfigId) {
  const values = await chrome.storage.local.get(STORAGE_KEYS.apiConfigs);
  const configs = Array.isArray(values[STORAGE_KEYS.apiConfigs]) ? values[STORAGE_KEYS.apiConfigs] : [];
  const config = configs.find((item) => item.id === apiConfigId) || configs[0];

  if (!config) {
    throw new Error("请先添加 API 配置。");
  }

  return {
    id: String(config.id),
    name: String(config.name || "未命名 API"),
    apiKey: String(config.apiKey || ""),
    baseUrl: String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    modelsUrl: String(config.modelsUrl || buildDefaultModelsUrl(config.baseUrl || DEFAULT_BASE_URL)),
    requestType: normalizeRequestType(config.requestType)
  };
}

async function getSelectedApiAndModel() {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.apiConfigs,
    STORAGE_KEYS.selectedApiId,
    STORAGE_KEYS.selectedModelByApi
  ]);

  const configs = Array.isArray(values[STORAGE_KEYS.apiConfigs]) ? values[STORAGE_KEYS.apiConfigs] : [];
  const selectedApiId = values[STORAGE_KEYS.selectedApiId] || configs[0]?.id || "";
  const selectedModelByApi = values[STORAGE_KEYS.selectedModelByApi] || {};
  const model = selectedModelByApi[selectedApiId] || "";

  if (!selectedApiId) {
    throw new Error("请先在插件 popup 中配置并选择 API。");
  }

  if (!model) {
    throw new Error("请先在插件 popup 中选择模型。");
  }

  return {
    apiConfigId: selectedApiId,
    model
  };
}

function assertApiConfigReady(config, options = {}) {
  if (!config?.apiKey) {
    throw new Error("请先配置 API Key。");
  }

  if (!config.baseUrl) {
    throw new Error("请先配置基础 URL。");
  }

  if (!config.modelsUrl && options.requireModelsUrl !== false) {
    throw new Error("请先配置模型列表接口 URL。");
  }

  if (options.requireModel !== false && !options.model) {
    throw new Error("请先选择模型。");
  }
}

function parseModelList(data) {
  const rawModels = findModelArray(data);

  return rawModels
    .map((item) => {
      if (typeof item === "string") {
        return { id: item, name: item };
      }

      const id = item?.id || item?.name || item?.model || item?.model_name;
      if (!id) {
        return null;
      }

      return {
        id: String(id),
        name: String(item.display_name || item.label || item.name || id)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function findModelArray(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.models)) {
    return data.models;
  }

  if (Array.isArray(data?.data?.models)) {
    return data.data.models;
  }

  if (Array.isArray(data?.result?.models)) {
    return data.result.models;
  }

  if (Array.isArray(data?.result?.data)) {
    return data.result.data;
  }

  return [];
}

function parseJsonResponse(rawText, label) {
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(`${label} 没有返回合法 JSON：${truncate(rawText)}`);
  }
}

function parseApiResponse(rawText, label) {
  if (!rawText) {
    return null;
  }

  const trimmed = rawText.trim();
  if (trimmed.startsWith("data:")) {
    return parseServerSentEvents(trimmed, label);
  }

  return parseJsonResponse(rawText, label);
}

function parseServerSentEvents(rawText, label) {
  const chunks = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  const parsedChunks = [];

  for (const chunk of chunks) {
    try {
      parsedChunks.push(JSON.parse(chunk));
    } catch (error) {
      throw new Error(`${label} 返回了无法解析的流式片段：${truncate(chunk)}`);
    }
  }

  const content = parsedChunks
    .map((chunk) => {
      const delta = chunk?.choices?.[0]?.delta;
      const message = chunk?.choices?.[0]?.message;
      return delta?.content || message?.content || chunk?.output_text || "";
    })
    .join("")
    .trim();

  if (content) {
    return {
      choices: [
        {
          message: {
            content
          }
        }
      ]
    };
  }

  const fallbackText = parsedChunks
    .map((chunk) => chunk?.choices?.[0]?.delta?.reasoning_content || "")
    .join("")
    .trim();

  if (fallbackText) {
    return {
      choices: [
        {
          message: {
            content: fallbackText
          }
        }
      ]
    };
  }

  throw new Error(`${label} 返回了流式响应，但没有可展示的文本。`);
}

function validateUrl(value, label) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("URL 协议必须是 http 或 https。");
    }
  } catch (error) {
    throw new Error(`${label} 无效：${getErrorMessage(error)}`);
  }
}

function truncate(text, maxLength = 300) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function buildRequestEndpoint(config) {
  if (config.requestType === "responses") {
    return buildResponsesEndpoint(config.baseUrl);
  }

  return buildChatCompletionsEndpoint(config.baseUrl);
}

function buildRequestBody({ requestType, model, question, textContext, imageDataUrl }) {
  if (requestType === "responses") {
    return buildResponsesRequestBody({ model, question, textContext, imageDataUrl });
  }

  return buildChatCompletionsRequestBody({ model, question, textContext, imageDataUrl });
}

function buildResponsesRequestBody({ model, question, textContext, imageDataUrl }) {
  const content = [
    {
      type: "input_text",
      text: buildPromptText(question, textContext)
    }
  ];

  if (imageDataUrl) {
    content.push({
      type: "input_image",
      image_url: imageDataUrl
    });
  }

  return {
    model,
    input: [
      {
        role: "user",
        content
      }
    ]
  };
}

function buildChatCompletionsRequestBody({ model, question, textContext, imageDataUrl }) {
  const promptText = buildPromptText(question, textContext);
  const content = imageDataUrl
    ? [
        {
          type: "text",
          text: promptText
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl,
            detail: "high"
          }
        }
      ]
    : promptText;

  return {
    model,
    messages: [
      {
        role: "user",
        content
      }
    ],
    temperature: 0.2
  };
}

function buildResponsesEndpoint(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) {
    return normalized;
  }

  return `${normalized}/responses`;
}

function buildChatCompletionsEndpoint(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
}

function buildDefaultModelsUrl(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return normalized.endsWith("/models") ? normalized : `${normalized}/models`;
}

function normalizeRequestType(value) {
  return value === "responses" ? "responses" : "chat_completions";
}

function extractResponseText(data) {
  if (data?.output_text) {
    return String(data.output_text).trim();
  }

  const outputText = data?.output
    ?.flatMap((item) => item.content || [])
    ?.filter((content) => content.type === "output_text" && content.text)
    ?.map((content) => content.text)
    ?.join("\n")
    ?.trim();

  if (outputText) {
    return outputText;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => part.text || part.content || "")
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  const legacyText = data?.choices?.[0]?.text;
  if (legacyText) {
    return String(legacyText).trim();
  }

  throw new Error("API 没有返回可展示的文本。");
}

async function sendMessageToTabWithInjection(tabId, message) {
  try {
    return await sendMessageToTab(tabId, message);
  } catch (firstError) {
    debugLog("initial content-script message failed, trying injection", getErrorMessage(firstError));

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"]
      });
    } catch (injectionError) {
      throw new Error(`无法注入框选脚本：${getErrorMessage(injectionError)}`);
    }

    return sendMessageToTab(tabId, message);
  }
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "页面没有接受框选请求。"));
        return;
      }

      resolve(response);
    });
  });
}

async function setLatestJob(job) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.latestJob]: {
      ...job,
      updatedAt: job.updatedAt || Date.now()
    }
  });
}

async function failLatestJob(error) {
  const message = getErrorMessage(error);
  debugError("job failed", message);
  await setLatestJob({
    status: "error",
    message,
    error: message,
    updatedAt: Date.now()
  });
}

function isValidRegion(region) {
  return Boolean(
    region &&
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height) &&
    region.width > 0 &&
    region.height > 0
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function debugLog(message, details) {
  if (!DEBUG) {
    return;
  }

  console.log(`[QuerySnap background] ${message}`, details ?? "");
}

function debugError(message, error) {
  console.error(`[QuerySnap background] ${message}`, error);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
