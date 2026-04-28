# QuerySnap

> 一个 Chrome 浏览器插件。框选网页截图或粘贴文字，使用多个 OpenAI 兼容 API 配置向 AI 提问。

[![Manifest](https://img.shields.io/badge/manifest-v3-blue)](manifest.json)
[![Version](https://img.shields.io/badge/version-0.3.0-green)](#)

---

## 功能

- **多 API 配置** — 保存和管理多个 OpenAI 兼容 API（如 OpenAI、第三方网关、本地模型），每个配置独立保存名称、Key、Base URL 和接口格式。
- **动态模型列表** — 切换 API 后自动拉取可用模型，支持多种 `/models` 响应格式（`data[]`、`models[]` 等）。
- **框选截图提问** — 网页上拖动选择区域，插件自动截图、裁剪，将图片和问题一起发给 AI 分析。
- **纯文本提问** — 粘贴网页文字或报错日志，附带问题发送给 AI。
- **悬浮按钮 FAB** — 每个网页右上角显示一个圆形蓝色悬浮按钮（Floating Action Button），点击展开完整输入面板。可拖动、可关闭。
- **双接口格式** — 同时支持 Chat Completions（兼容性更好）和 Responses API。
- **流式响应解析** — 自动解析 SSE 流式数据（`data:` 格式），提取最终文本。
- **本地存储** — 所有配置和任务状态保存在 `chrome.storage.local`，不依赖外部服务。
- **错误覆盖全面** — 覆盖缺 Key、缺模型、截图失败、裁剪失败、网络错误、模型列表为空、SSE 解析失败等场景。

## 截图

> 在 `chrome://extensions` 加载插件后，打开任意网页即可看到右上角的蓝色圆形 Q 按钮。

## 安装

```bash
git clone https://github.com/你的用户名/querysnap.git
```

1. 打开 Chrome，进入 `chrome://extensions`
2. 打开右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择包含 `manifest.json` 的项目目录
5. 将 QuerySnap 固定到工具栏

## 快速开始

1. 点击工具栏 **QuerySnap 图标**打开弹窗
2. 填写 API Key 和 Base URL，点击「保存当前 API 配置」
3. 选择模型
4. 输入问题，点击「**框选截图提问**」或「**纯文本提问**」
5. 或者直接打开任意网页，点击右上角蓝色 **Q** 悬浮按钮，输入问题后发送

## 项目结构

```
.
├── manifest.json        # 插件清单 (Manifest V3)
├── popup.html           # 弹窗页面结构
├── popup.css            # 弹窗样式
├── popup.js             # API 配置管理、模型加载、提问入口
├── background.js        # Service Worker: 截图、裁剪、API 请求、SSE 解析
├── content-script.js    # 网页注入: 框选交互 + 悬浮 FAB 按钮
├── .gitignore
└── README.md
```

## API 配置

打开 QuerySnap popup 在配置区管理：

| 字段 | 说明 |
|------|------|
| API 名称 | 自定义，如 `OpenAI`、`Qnaigc`、`Local LLM` |
| API Key | API 访问密钥，保存在本地 `chrome.storage` |
| 基础 URL | 默认 `https://api.openai.com/v1`，第三方填写到 `/v1` 层 |
| 接口格式 | `Chat Completions`（兼容性好）或 `Responses API` |
| 模型 | 保存配置后自动获取，也可手动刷新 |

模型列表自动从 `{Base URL}/models` 获取，支持以下响应格式：

```json
{ "data": [{ "id": "gpt-4.1-mini" }] }
```
```json
{ "models": [{ "id": "claude-3-sonnet", "name": "Claude 3 Sonnet" }] }
```

## 请求格式

### Chat Completions

```
POST {Base URL}/chat/completions
```

截图提问请求体：

```json
{
  "model": "所选模型",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "用户问题及文本上下文" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }],
  "temperature": 0.2
}
```

### Responses API

```
POST {Base URL}/responses
```

截图提问请求体：

```json
{
  "model": "所选模型",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "用户问题及文本上下文" },
      { "type": "input_image", "image_url": "data:image/jpeg;base64,..." }
    ]
  }]
}
```

纯文本提问不附带图片块。截图会转为 JPEG 格式（quality=0.88），长边超过 1600px 时等比缩放。

## 悬浮按钮交互

![FAB](https://img.shields.io/badge/FAB-56px_round_blue_button-blue)

| 操作 | 效果 |
|------|------|
| 点击蓝色 **Q** 按钮 | 展开完整输入面板 |
| 点击 **−** | 收起回圆形按钮 |
| 点击 **×** | 关闭浮窗（直到 next page load） |
| 拖动 Q 按钮 / 标题栏 | 移动浮窗位置 |
| 「复制文字提问」| 用当前选中文字 + 问题发给 AI |
| 「截图提问」| 进入框选模式，裁剪选区截图发给 AI |
| `Ctrl/Cmd + Enter` | 快捷触发「复制文字提问」 |

## 消息流

```
Popup / FAB  ──→  Background (Service Worker)  ──→  Content Script
                    │
                    ├── FETCH_MODELS           → API /models
                    ├── START_SCREENSHOT_QUESTION → 注入框选
                    ├── CAPTURE_REGION_SELECTED   → 截图/裁剪/请求
                    ├── ASK_TEXT_QUESTION         → API chat|responses
                    ├── ASK_FLOATING_TEXT_QUESTION
                    └── START_FLOATING_SCREENSHOT_QUESTION
```

## 调试

日志前缀：

- `[QuerySnap background]` — Service Worker 控制台（`chrome://extensions` → 检查视图）
- `[QuerySnap content]` — 网页 DevTools 控制台

设置 `DEBUG = true`（在 `background.js` 和 `content-script.js` 顶部）可开启详细日志。

## 常见问题

| 现象 | 可能原因及解决 |
|------|---------------|
| 点击截图后无法框选 | 刷新网页（`chrome://` 页面不支持注入）|
| 提示缺少 API Key | 在 popup 中填写并保存 |
| 模型列表获取失败 | 检查 Base URL 和 Key，确认服务支持 `/models` |
| API 请求失败 | 检查 URL 是否到 `/v1` 层，模型是否支持图片 |
| 截图分析不准 | 换用视觉多模态模型，检查接口格式匹配 |
| 返回乱码/空结果 | 插件自动解析 SSE 流式，未匹配到文本时会报错提示 |



## License

[MIT](LICENSE)
