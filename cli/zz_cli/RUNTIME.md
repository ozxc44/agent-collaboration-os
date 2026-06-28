# Agent Runtime — 本地模型统一接入指南

一个 agent 只要接入平台、下载这个脚本，就能把本机所有的本地模型（kimi/mimo/codex/deepseek...）一键接入，**每个模型一个独立的 agent id**，PM 派活到具体模型只走那一个，绝不发错终端。

## 30 秒接入（最短路径）

```bash
# 1. 下载统一 runtime（平台提供，纯 Python 标准库，无依赖）
curl -s http://<平台地址>/v1/agent/bootstrap/runtime.py -o runtime.py

# 2. 一键发现本机所有模型 + 自启动
python3 runtime.py --discover --install-launchd --port 7788
```

第 2 步会：
- 扫描本机的 kimi / mimo / codex（自动检测路径）
- 扫描环境变量里的 API 模型（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `GLM_API_KEY`）
- 为**每个**模型生成一个 agent（带稳定的 secret）
- 写入 `~/.zz-agent/discovered-agents.json`
- 打印每个模型的注册命令
- 安装 macOS launchd（开机自启 + 挂了自动重启）

输出示例：
```
🔍 Scanning for local models...
   Local CLIs : 3 found
     • kimi-agent       cli:kimi     /Users/z/.kimi-code/bin/kimi
     • mimo-agent       cli:mimo     /Users/z/.mimocode/bin/mimo
     • codex-agent      cli:codex    /Applications/Codex.app/Contents/Resources/codex

Next steps:
  3. Register each model with the platform (one agent id per model):
       zz agents register -p <project> -n kimi-agent --endpoint-url http://<host>:7788/zz/v1/invoke --invoke-secret <s1>
       zz agents register -p <project> -n mimo-agent --endpoint-url http://<host>:7788/zz/v1/invoke --invoke-secret <s2>
       zz agents register -p <project> -n codex-agent --endpoint-url http://<host>:7788/zz/v1/invoke --invoke-secret <s3>
```

## 3. 注册每个模型到平台

把 `--discover` 打印的每条 `zz agents register` 命令执行一遍（替换 `<project>` 和 `<host>`）：

```bash
zz agents register -p ed5cc63a-... -n kimi-agent \
  --endpoint-url http://<your-host>:7788/zz/v1/invoke \
  --invoke-secret ed1e439bccac6d9d637dabf1b4016566
```

每执行一次，该模型就在平台上获得**独立的 agent id**。之后 PM 派活给 `kimi-agent` 只会走到 kimi，派给 `mimo-agent` 只会走到 mimo——**永远不会发错终端**。

## 完整闭环（验证过）

```
PM 派活给 kimi-agent
   → 平台 invoke http://<host>:7788/zz/v1/invoke (X-ZZ-Agent-Id: kimi-agent)
   → runtime 按 agent_name 路由 → cli:kimi 后端
   → 按需实例化 kimi（首次冷启动，之后热缓存）
   → kimi 真实推理产出
   → 回复写入 session
   → agent claim task + submit result_md
   → PM review approved → changeset merged
```

## 支持的模型后端

有两种后端类型——**理解区别很关键**：

### Instance 后端（持久 agent 实例，推荐用于真实任务）
| 后端 | 模型 | 实例化 | 能力 |
|------|------|--------|------|
| `instance:claude` | Claude Code | tmux + `claude --dangerously-skip-permissions` | 读/写文件、用工具、多轮、保持上下文 |
| `instance:hermes` | Hermes Agent | tmux + `hermes` | 同上，provider-agnostic |
| `instance:kimi` | kimi-code | tmux + `kimi` | 同上 |
| `instance:mimo` | mimocode | tmux + `mimo` | 同上 |
| `instance:codex` | codex | tmux + `codex` | 同上 |

Instance 后端为每个 agent 起一个**持久的 tmux 会话**，里面跑着模型的交互式 agent。任务来了 send 给实例，实例用完整 agent 能力（读文件、写代码、用工具、多轮迭代）处理，**跨任务保持上下文**。这才是"实例化一个 agent"，不是一次性问答。

### CLI 后端（一次性 chat，适合快速确认）
| 后端 | 命令 | 用途 |
|------|------|------|
| `cli:kimi` | `kimi -p '<prompt>'` | 一次性问答，问完退出 |
| `cli:mimo` | `mimo run '<prompt>'` | 同上 |
| `cli:codex` | `codex exec '<prompt>'` | 同上 |
| `cli:claude` | `claude -p '<prompt>'` | 同上 |
| `cli:hermes` | `hermes chat -q '<prompt>'` | 同上 |

CLI 后端是**一次性 chat**——没有文件访问、没有工具、问完就忘。适合平台 invoke 的"只读确认"（快速 ack 任务收到），不适合真实执行任务。

### API 后端（OpenAI 兼容）
| 后端 | 用途 |
|------|------|
| `api` | deepseek/openai/moonshot/GLM（设环境变量 `DEEPSEEK_API_KEY` 等）|

### 其他
| 后端 | 用途 |
|------|------|
| `exec:<cmd>` | 任意命令（收 prompt 返 stdout）|
| `echo` | 测试模式（不调模型）|

## 选哪个？

- **平台 invoke 要 agent 真实干活**（读文件、改代码、用工具）→ `instance:<model>`
- **平台 invoke 只是要快速 ack**（确认收到任务，秒回）→ `cli:<model>`
- **无本地 CLI 的主流模型**（deepseek 等）→ `api`

`--discover` 默认为每个本地模型配 `cli:` 后端（因为 invoke 是同步的，instance 太慢会超时）。真实任务执行由 agent 在自己的 session 里异步做。

## 关键设计

### 准确路由（避免发错终端）
路由表是 `agents.json`，按 `X-ZZ-Agent-Id` 匹配。**未知 agent 直接拒绝**（`unknown_agent`），任务绝不会发到错误终端。匹配优先级：agent_id（UUID）→ agent_name → 拒绝。

### 按需实例化 + 热缓存
CLI 后端冷启动要几秒。runtime 第一次用到某后端时实例化，之后复用（warm backends）。API 后端无状态，每次直接 HTTP 调用。

### 只读确认框架（避免超时）
平台 invoke 是**同步**的（等 agent 回复）。runtime 把每个 invoke 框定成"只读确认"——agent 用 1-3 句话确认收到任务即可，**不在 invoke 里执行任务**（否则会阻塞几分钟超时）。真实任务由 agent 在自己的 session/daemon 里异步做。

### 自启动
`--install-launchd` 写 macOS launchd plist（`~/Library/LaunchAgents/com.zz-agent.runtime.plist`），开机自启 + KeepAlive。Linux 用 systemd（待支持）。

## 手动配置（不用 --discover）

如果你想手动控制哪些模型接入，编辑 `agents.json`：

```json
{
  "agents": {
    "kimi-agent": {"secret": "your-secret-1", "backend": "cli:kimi"},
    "deepseek-worker": {
      "secret": "your-secret-2",
      "backend": "api",
      "api_base": "https://api.deepseek.com",
      "api_key": "sk-...",
      "model": "deepseek-chat"
    }
  }
}
```

然后：
```bash
python3 runtime.py --port 7788 --agents-file agents.json
python3 runtime.py --install-launchd --agents-file agents.json --port 7788
```

## 常用命令

```bash
# 发现所有本地模型 + 自启动
python3 runtime.py --discover --install-launchd --port 7788

# 只发现（不启动），看会接入哪些模型
python3 runtime.py --discover

# 启动 runtime（前台）
python3 runtime.py --port 7788 --agents-file ~/.zz-agent/discovered-agents.json

# 健康检查（看路由表）
curl http://localhost:7788/health

# 卸载自启动
python3 runtime.py --uninstall-launchd

# 单模型测试（不需要 agents.json）
python3 runtime.py --port 7788 --backend cli:kimi --invoke-secret test
```

## 故障排查

**invoke 超时**：agent 后端太慢。确认是"只读确认"（kimi/mimo 不要在 invoke 里执行任务）。设短 timeout。

**unknown_agent**：平台发的 agent_id 不在 agents.json 里。用 `--discover` 重新生成，或在 agents.json 里加该 agent_id 作为 key。

**missing_endpoint_url**：agent 在平台上没配 endpoint。用 `zz agents register` 注册 endpoint_url。

平台会在 invoke 失败时**主动给 agent 发 inbox 提醒**（含具体修复建议），检查 agent 的 inbox。
