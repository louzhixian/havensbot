# Claude CLI API Wrapper Design

## Background

ArkCore 目前使用 Gemini API 进行 LLM 调用（digest 摘要、diary 对话等），需要付费的 API key。bunker 服务器上有 Claude Code CLI 可用，可以包装成 OpenAI-compatible API 供 ArkCore 使用，复用 Claude Code 的订阅 quota。

> **Note**: 原计划使用 Gemini CLI，但发现 Gemini CLI 仍需要 API key 认证，因此改用 Claude Code CLI。

## Goal

在 bunker 上部署一个轻量级 HTTP 服务，将 Claude Code CLI 包装成 OpenAI Chat Completions API 格式，供 ArkCore 无缝切换使用。

## Scope

### In Scope
- 实现 `/v1/chat/completions` endpoint
- 支持多轮对话（messages 数组）
- Bearer token 认证（复用 ArkCore 的 LLM_API_KEY）
- 部署到 bunker 服务器

### Out of Scope
- Streaming 响应（ArkCore 不需要）
- 其他 OpenAI endpoints（/models, /embeddings 等）
- 多后端负载均衡

## Architecture

```
ArkCore (arkcore/sakura)            bunker
┌─────────────────┐                ┌─────────────────────────┐
│  LlmClient      │ ──HTTP──────>  │  claude-api-wrapper     │
│                 │                │  (Node.js HTTP server)  │
│  LLM_BASE_URL=  │                │         │               │
│  http://bunker: │                │         ▼               │
│  3100           │                │  spawn('claude --print')│
└─────────────────┘                └─────────────────────────┘
```

## Implementation

### Project Structure

```
~/claude-api-wrapper/
├── index.js                              # HTTP server + endpoint
├── .env                                  # API_KEY configuration
├── com.zhixian.claude-api-wrapper.plist  # launchd service
└── logs/
    ├── stdout.log
    └── stderr.log
```

### Message Conversion

OpenAI messages 数组转换为 Claude CLI prompt：

```javascript
function convertMessages(messages) {
  return messages.map(m => {
    if (m.role === "system") return `<system>\n${m.content}\n</system>`;
    if (m.role === "user") return `User: ${m.content}`;
    if (m.role === "assistant") return `Assistant: ${m.content}`;
    return m.content;
  }).join("\n\n");
}
```

### API Endpoint

```javascript
// POST /v1/chat/completions
// Request:
{
  "model": "claude-cli",  // ignored, always uses claude CLI
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "temperature": 0.3,  // ignored
  "max_tokens": 4000   // ignored
}

// Response:
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "claude-cli",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### Authentication

验证 `Authorization: Bearer <token>` header，token 与 `.env` 中配置的 `API_KEY` 比对。

### CLI Invocation

使用 Node.js `spawn` 通过 stdin 传入 prompt，避免 shell 转义问题：

```javascript
const proc = spawn("claude", ["--print"], {
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stdin.write(prompt);
proc.stdin.end();
```

### Error Handling

- CLI 超时：返回 504 Gateway Timeout
- CLI 错误：返回 500 + 错误信息
- 认证失败：返回 401 Unauthorized

## Deployment

### launchd Service (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.zhixian.claude-api-wrapper</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/Users/zhixian/claude-api-wrapper/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

安装：
```bash
cp com.zhixian.claude-api-wrapper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.zhixian.claude-api-wrapper.plist
```

### ArkCore Configuration

```bash
# arkcore server .env
LLM_BASE_URL=http://bunker:3100
LLM_API_KEY=<configured-api-key>
LLM_MODEL=claude-cli
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Claude Code rate limiting | 记录调用频率，必要时加 delay |
| CLI 响应慢导致超时 | 设置 2 分钟超时，ArkCore 有重试机制 |
| bunker 不可用 | ArkCore 有 fallback 机制，降级处理 |

## Testing

1. 本地测试：`curl -X POST http://localhost:3100/v1/chat/completions -H "Authorization: Bearer xxx" -d '...'`
2. 集成测试：修改 ArkCore 配置后触发 digest 或 diary

## Acceptance Criteria

- [x] `/v1/chat/completions` endpoint 正常响应
- [x] Bearer token 认证生效
- [x] ArkCore 切换配置后 digest/diary 功能正常
- [x] launchd service 稳定运行

## Implementation Status

**Completed**: 2026-01-15

服务已部署在 bunker:3100，ArkCore 已配置使用该服务。
