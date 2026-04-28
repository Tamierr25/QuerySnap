const STORAGE_KEYS = {
  apiConfigs: "querySnapApiConfigs",
  selectedApiId: "querySnapSelectedApiId",
  selectedModelByApi: "querySnapSelectedModelByApi",
  latestJob: "querySnapLatestJob"
};

const DEFAULT_API_CONFIG = {
  id: "openai-default",
  name: "OpenAI",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelsUrl: "https://api.openai.com/v1/models",
  requestType: "chat_completions"
};

const apiSelect = document.getElementById("apiSelect");
const modelSelect = document.getElementById("modelSelect");
const apiNameInput = document.getElementById("apiNameInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const requestTypeSelect = document.getElementById("requestTypeSelect");
const questionInput = document.getElementById("questionInput");
const textInput = document.getElementById("textInput");
const newApiButton = document.getElementById("newApiButton");
const deleteApiButton = document.getElementById("deleteApiButton");
const saveApiButton = document.getElementById("saveApiButton");
const screenshotAskButton = document.getElementById("screenshotAskButton");
const textAskButton = document.getElementById("textAskButton");
const clearButton = document.getElementById("clearButton");
const statusBox = document.getElementById("statusBox");
const answerBox = document.getElementById("answerBox");

let apiConfigs = [];
let selectedApiId = "";
let selectedModelByApi = {};
let loadedModels = [];

document.addEventListener("DOMContentLoaded", init);
apiSelect.addEventListener("change", handleApiSelectionChange);
modelSelect.addEventListener("change", handleModelSelectionChange);
newApiButton.addEventListener("click", createApiConfigDraft);
deleteApiButton.addEventListener("click", deleteSelectedApiConfig);
saveApiButton.addEventListener("click", () => saveCurrentApiConfig({ reloadModels: true }));
screenshotAskButton.addEventListener("click", startScreenshotQuestion);
textAskButton.addEventListener("click", askTextQuestion);
clearButton.addEventListener("click", clearResult);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[STORAGE_KEYS.latestJob]) {
    renderJob(changes[STORAGE_KEYS.latestJob].newValue);
  }
});

async function init() {
  await loadStoredState();
  renderApiSelect();
  renderSelectedApiForm();
  await loadModelsForSelectedApi();

  const { querySnapLatestJob } = await chrome.storage.local.get(STORAGE_KEYS.latestJob);
  renderJob(querySnapLatestJob);
}

async function loadStoredState() {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.apiConfigs,
    STORAGE_KEYS.selectedApiId,
    STORAGE_KEYS.selectedModelByApi,
    STORAGE_KEYS.latestJob,
    "querySnapApiKey",
    "querySnapBaseUrl",
    "querySnapModel",
    "openaiApiKey"
  ]);

  apiConfigs = normalizeApiConfigs(values[STORAGE_KEYS.apiConfigs]);

  // Migrate from the previous single-API storage format, if present.
  if (!apiConfigs.length) {
    apiConfigs = [{
      ...DEFAULT_API_CONFIG,
      apiKey: values.querySnapApiKey || values.openaiApiKey || "",
      baseUrl: values.querySnapBaseUrl || DEFAULT_API_CONFIG.baseUrl,
      modelsUrl: buildDefaultModelsUrl(values.querySnapBaseUrl || DEFAULT_API_CONFIG.baseUrl)
    }];
  }

  selectedApiId = values[STORAGE_KEYS.selectedApiId] || apiConfigs[0]?.id || "";
  selectedModelByApi = values[STORAGE_KEYS.selectedModelByApi] || {};

  if (values.querySnapModel && selectedApiId && !selectedModelByApi[selectedApiId]) {
    selectedModelByApi[selectedApiId] = values.querySnapModel;
  }

  await persistConfigState();
}

function normalizeApiConfigs(configs) {
  if (!Array.isArray(configs)) {
    return [];
  }

  return configs
    .filter((config) => config && typeof config === "object")
    .map((config) => ({
      id: String(config.id || createId()),
      name: String(config.name || "未命名 API"),
      apiKey: String(config.apiKey || ""),
      baseUrl: String(config.baseUrl || DEFAULT_API_CONFIG.baseUrl),
      modelsUrl: String(config.modelsUrl || buildDefaultModelsUrl(config.baseUrl || DEFAULT_API_CONFIG.baseUrl)),
      requestType: normalizeRequestType(config.requestType)
    }));
}

function renderApiSelect() {
  apiSelect.replaceChildren();

  for (const config of apiConfigs) {
    const option = document.createElement("option");
    option.value = config.id;
    option.textContent = config.name;
    apiSelect.appendChild(option);
  }

  apiSelect.value = selectedApiId;
}

function renderSelectedApiForm() {
  const config = getSelectedApiConfig();
  if (!config) {
    apiNameInput.value = "";
    apiKeyInput.value = "";
    baseUrlInput.value = "";
    requestTypeSelect.value = DEFAULT_API_CONFIG.requestType;
    return;
  }

  apiNameInput.value = config.name;
  apiKeyInput.value = config.apiKey;
  baseUrlInput.value = config.baseUrl;
  requestTypeSelect.value = normalizeRequestType(config.requestType);
}

async function handleApiSelectionChange() {
  selectedApiId = apiSelect.value;
  await persistConfigState();
  renderSelectedApiForm();
  await loadModelsForSelectedApi();
}

async function handleModelSelectionChange() {
  if (!selectedApiId || !modelSelect.value) {
    return;
  }

  selectedModelByApi[selectedApiId] = modelSelect.value;
  await persistConfigState();
}

async function createApiConfigDraft() {
  const config = {
    id: createId(),
    name: `API ${apiConfigs.length + 1}`,
    apiKey: "",
    baseUrl: DEFAULT_API_CONFIG.baseUrl,
    modelsUrl: DEFAULT_API_CONFIG.modelsUrl,
    requestType: DEFAULT_API_CONFIG.requestType
  };

  apiConfigs.push(config);
  selectedApiId = config.id;
  await persistConfigState();
  renderApiSelect();
  renderSelectedApiForm();
  renderModelSelect([], "请填写并保存 API Key 后刷新模型。");
  setStatus("已创建新的 API 配置草稿。");
}

async function deleteSelectedApiConfig() {
  if (apiConfigs.length <= 1) {
    setError("至少需要保留一个 API 配置。");
    return;
  }

  const index = apiConfigs.findIndex((config) => config.id === selectedApiId);
  if (index === -1) {
    setError("没有找到要删除的 API 配置。");
    return;
  }

  const [deleted] = apiConfigs.splice(index, 1);
  delete selectedModelByApi[deleted.id];
  selectedApiId = apiConfigs[Math.max(0, index - 1)]?.id || apiConfigs[0]?.id || "";

  await persistConfigState();
  renderApiSelect();
  renderSelectedApiForm();
  await loadModelsForSelectedApi();
  setStatus(`已删除 API 配置：${deleted.name}`);
}

async function saveCurrentApiConfig(options = {}) {
  const current = getSelectedApiConfig();
  if (!current) {
    setError("没有可保存的 API 配置。");
    return null;
  }

  const next = {
    ...current,
    name: apiNameInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    baseUrl: normalizeBaseUrl(baseUrlInput.value.trim()),
    requestType: normalizeRequestType(requestTypeSelect.value)
  };

  if (!next.name) {
    setError("请填写 API 名称。");
    apiNameInput.focus();
    return null;
  }

  if (!next.baseUrl) {
    setError("请填写基础 URL。");
    baseUrlInput.focus();
    return null;
  }

  next.modelsUrl = buildDefaultModelsUrl(next.baseUrl);

  apiConfigs = apiConfigs.map((config) => config.id === next.id ? next : config);
  selectedApiId = next.id;
  await persistConfigState();
  renderApiSelect();
  apiSelect.value = selectedApiId;

  if (options.reloadModels) {
    setStatus("API 配置已保存，正在刷新模型列表...");
    await loadModelsForSelectedApi({ force: true });
  } else if (!options.silent) {
    setStatus("API 配置已保存。");
  }

  return next;
}

async function loadModelsForSelectedApi(options = {}) {
  const config = getSelectedApiConfig();
  loadedModels = [];

  if (!config) {
    renderModelSelect([], "请先添加 API 配置。");
    return;
  }

  if (!config.apiKey) {
    renderModelSelect([], "请先填写并保存 API Key。");
    setStatus("当前 API 配置缺少 API Key。");
    return;
  }

  renderModelSelect([], "正在获取模型列表...");

  chrome.runtime.sendMessage({
    type: "FETCH_MODELS",
    payload: {
      apiConfigId: config.id,
      force: Boolean(options.force)
    }
  }, async (response) => {
    if (chrome.runtime.lastError) {
      renderModelSelect([], "模型列表获取失败。");
      setError(chrome.runtime.lastError.message);
      return;
    }

    if (!response?.ok) {
      renderModelSelect([], "模型列表获取失败。");
      setError(response?.error || "模型列表获取失败。");
      return;
    }

    loadedModels = response.models || [];
    renderModelSelect(loadedModels);

    if (modelSelect.value) {
      selectedModelByApi[selectedApiId] = modelSelect.value;
      await persistConfigState();
    }

    setStatus(`已加载 ${loadedModels.length} 个模型。`);
  });
}

function renderModelSelect(models, placeholder = "没有可用模型。") {
  modelSelect.replaceChildren();

  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
    return;
  }

  const selectedModel = selectedModelByApi[selectedApiId] || "";
  modelSelect.disabled = false;

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name || model.id;
    modelSelect.appendChild(option);
  }

  if (selectedModel && models.some((model) => model.id === selectedModel)) {
    modelSelect.value = selectedModel;
  } else {
    modelSelect.value = models[0].id;
  }
}

async function startScreenshotQuestion() {
  const request = await buildQuestionRequest({ requireQuestion: false });
  if (!request) {
    return;
  }

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      setError("没有找到当前标签页。");
      return;
    }

    setBusy(true);
    setStatus("正在启动框选模式...");

    chrome.runtime.sendMessage({
      type: "START_SCREENSHOT_QUESTION",
      payload: {
        ...request,
        tabId: tab.id
      }
    }, (response) => {
      setBusy(false);

      if (chrome.runtime.lastError) {
        setError(chrome.runtime.lastError.message);
        return;
      }

      if (!response?.ok) {
        setError(response?.error || "无法启动框选截图。");
        return;
      }

      setStatus("框选模式已开启。弹窗关闭后，请在网页上拖动选择区域。");
      window.close();
    });
  } catch (error) {
    setBusy(false);
    setError(getErrorMessage(error));
  }
}

async function askTextQuestion() {
  const request = await buildQuestionRequest({ requireQuestion: true });
  if (!request) {
    return;
  }

  setBusy(true);
  setStatus("正在请求 AI...");

  chrome.runtime.sendMessage({
    type: "ASK_TEXT_QUESTION",
    payload: request
  }, (response) => {
    setBusy(false);

    if (chrome.runtime.lastError) {
      setError(chrome.runtime.lastError.message);
      return;
    }

    if (!response?.ok) {
      setError(response?.error || "AI 请求失败。");
      return;
    }

    setStatus("请求完成。");
    answerBox.textContent = response.answer || "AI 没有返回内容。";
  });
}

async function buildQuestionRequest(options = {}) {
  const question = questionInput.value.trim();
  if (options.requireQuestion !== false && !question) {
    setError("请先输入问题。");
    questionInput.focus();
    return null;
  }

  const config = await saveCurrentApiConfig({ silent: true });
  if (!config) {
    return null;
  }

  if (!config.apiKey) {
    setError("请先填写并保存 API Key。");
    apiKeyInput.focus();
    return null;
  }

  const model = modelSelect.value;
  if (!model) {
    setError("请先选择模型。");
    return null;
  }

  selectedModelByApi[selectedApiId] = model;
  await persistConfigState();

  return {
    question,
    textContext: textInput.value.trim(),
    apiConfigId: selectedApiId,
    model
  };
}

async function clearResult() {
  await chrome.storage.local.remove(STORAGE_KEYS.latestJob);
  setStatus("等待操作。");
  answerBox.textContent = "暂无回答。";
  statusBox.classList.remove("error");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getSelectedApiConfig() {
  return apiConfigs.find((config) => config.id === selectedApiId) || apiConfigs[0] || null;
}

async function persistConfigState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiConfigs]: apiConfigs,
    [STORAGE_KEYS.selectedApiId]: selectedApiId,
    [STORAGE_KEYS.selectedModelByApi]: selectedModelByApi
  });
}

function renderJob(job) {
  if (!job) {
    return;
  }

  if (job.status === "error") {
    setError(job.error || "请求失败。");
    return;
  }

  setStatus(job.message || statusText(job.status));

  if (job.answer) {
    answerBox.textContent = job.answer;
  }
}

function statusText(status) {
  const map = {
    waiting_selection: "等待框选截图区域。",
    capturing: "正在截图...",
    cropping: "正在裁剪图片...",
    requesting: "正在请求 AI...",
    done: "请求完成。"
  };

  return map[status] || "等待操作。";
}

function setBusy(isBusy) {
  screenshotAskButton.disabled = isBusy;
  textAskButton.disabled = isBusy;
  saveApiButton.disabled = isBusy;
  newApiButton.disabled = isBusy;
  deleteApiButton.disabled = isBusy;
}

function setStatus(message) {
  statusBox.classList.remove("error");
  statusBox.textContent = message;
}

function setError(message) {
  statusBox.classList.add("error");
  statusBox.textContent = message;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function buildDefaultModelsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl || DEFAULT_API_CONFIG.baseUrl);
  return normalized.endsWith("/models") ? normalized : `${normalized}/models`;
}

function normalizeRequestType(value) {
  return value === "responses" ? "responses" : "chat_completions";
}

function createId() {
  return `api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
