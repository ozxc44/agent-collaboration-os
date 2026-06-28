# OSS 可复用功能调研报告

> 调研了 6 个高星开源框架(MetaGPT/AutoGen/LangGraph/ChatDev/langflow/OpenHands),对照本平台(多 Agent 编排 + durable inbox + MD 工件 + Web 协作)找可复用功能。
> 代码已 clone 到 `/Volumes/CodexMac/oss-research/`。

## 核心结论

**你的平台在关键能力上已经领先**:durable inbox + lease(比 MetaGPT/AutoGen 的内存消息队列强)、MD 工件审计(比 ChatDev 的就地覆盖强)。**不应整体采用任何框架**——它们要么是 Python 库(非平台),要么是巨型 React 单页应用(langflow)。

真正值得移植的是 **5 个具体机制**,按价值/工作量排序:

---

## P0 — 高价值,低工作量(立即做)

### 1. Checkpoint 协议(LangGraph)— 替代"从 MD+DB 重建状态"
**来源**: `langgraph/libs/checkpoint/.../base/__init__.py:176` (BaseCheckpointSaver 接口) + sqlite/postgres 实现
**现状问题**: 平台每次重启从 MD+DB 重建状态,脆弱且无法时间旅行
**复用机制**: BaseCheckpointSaver 6 方法 + `versions_seen` 版本向量 → 每个 orchestration transition 写一个 checkpoint 行,重启时 `get_tuple` 精确恢复,只重跑版本推进的节点。支持 `get_state_history`(时间旅行/审计)和 `update_state`(HITL 注入)
**工作量**: 2-3 天(SQLite/Postgres schema + 6 方法实现 + 接入 orchestration 状态机)
**价值**: 解决状态恢复的根本可靠性问题,顺带获得审计/回放能力

### 2. Per-task LLM 成本/Token 追踪(OpenHands)— 平台缺失
**来源**: `OpenHands/openhands/app_server/app_conversation/sql_app_conversation_info_service.py:89-103`
**现状问题**: 平台完全不追踪每个 task 的 LLM 成本/token
**复用 schema**: `accumulated_cost`, `max_budget_per_task`(预算上限→可中止), `prompt_tokens`, `completion_tokens`, `cache_read_tokens`, `llm_model`
**工作量**: 半天(加列 + 在 complete/heartbeat 时记录)
**价值**: 解锁预算控制(防止失控 PM 循环烧钱)+ 成本可见性

### 3. 事件溯源审计日志(OpenHands)— 升级 TRACE.md
**来源**: `OpenHands/openhands/app_server/event/event_service_base.py` + `filesystem_event_service.py`
**现状问题**: TRACE.md 是手写摘要,可能漂移;无法精确查"所有 file-write 动作"
**复用机制**: 每个 event 一个 JSON 文件(`{task_id}/events/{event_id}.json`),typed discriminated union(MessageEvent/ObservationEvent/StatsEvent)。MD 工件从 event stream 生成,永不漂移
**工作量**: 1-2 天(event 类型定义 + filesystem service ~40 行 + 从 events 生成 RESULT/TRACE)
**价值**: 审计从"信任摘要"升级到"信任原始事件"

---

## P1 — 中价值,中工作量(规划做)

### 4. 工件依赖 DAG(MetaGPT)— 驱动增量重算
**来源**: `MetaGPT/metagpt/utils/dependency_file.py` (.dependencies.json) + `file_repository.py:46-89`
**现状问题**: 工件间链接靠约定,上游变更无法自动找出需重算的下游
**复用机制**: 每个 MD 工件存 `dependencies: list[artifact_id]`,持久化为邻接图。`get_changed_dependencies(artifact_id)` 让 PM 只重分发输入真正变化的 worker
**工作量**: 1-2 天(改 artifact schema + 60 行邻接图 + 查询)
**价值**: PM 调度从"全量重跑"升级到"变更驱动"

### 5. 可组合终止条件(AutoGen)— 规范化 PM 循环结束
**来源**: `autogen/.../conditions/_terminations.py` + `TerminationCondition` 基类(支持 `|`/`&` 组合)
**现状问题**: 终止硬编码为"所有 task approved";无预算/超时保护
**复用机制**: `TerminationReason` 接口,实现 `AllApproved` + `BudgetExceeded(token_cap)` + `WallClock(seconds)` + `ExternalStop`,在 PM 循环入口组合
**工作量**: 半天(接口 + 4 个实现 + 接入)
**价值**: 防止失控循环,规范化结束逻辑

---

## P2 — 低优先(后续考虑)

### 6. PM 进度账本 + 停滞检测(AutoGen MagenticOne)
**来源**: `autogen/.../_magentic_one/_magentic_one_orchestrator.py:300-449`
**机制**: 每轮 review 后 judge 模型返回 `{is_progress_being_made, is_in_loop}`,连续 N 轮停滞则重规划
**价值**: 检测"workers 原地打转"的失控场景
**工作量**: 1-2 天

### 7. 边上下文控制标志(ChatDev)— 规范化 task 依赖语义
**来源**: `ChatDev/runtime/edge/conditions/base.py:91-176`
**机制**: 依赖边带 `{carry, sticky, reset_on_enter}` 标志,声明式控制消费者看到什么上下文
**价值**: REVIEWER 节点"保留任务简报,丢弃中间噪声"用声明式表达
**工作量**: 1 天

### 8. 持久内核代码执行(AutoGen Jupyter)— 给需要跑代码的 agent
**来源**: `autogen/.../code_executors/jupyter/_jupyter_code_executor.py`
**机制**: NotebookClient 保持 kernel 存活,多步分析共享变量/数据
**价值**: 需要执行代码的 worker(数据分析/测试)
**工作量**: 2-3 天(含 Docker 沙箱)

### 9. 每节点执行徽章(langflow)— Web UI 增强
**来源**: `langflow/.../CustomNodes/GenericNode/components/NodeStatus/index.tsx:396-460`
**机制**: 状态图标 + inline token/时长 pill + "运行到此"按钮,纯展示逻辑
**价值**: trace 面板每行任务显示执行状态/成本
**工作量**: 半天(vanilla JS 可移植,无需 React)

---

## 明确不复用的

| 来源 | 不复用项 | 理由 |
|---|---|---|
| MetaGPT | 内存 MessageQueue / 无 lease 投递 | 你的 durable inbox 严格更优 |
| MetaGPT | LLM-as-state-machine (`_think`) | 脆弱(靠模型返回数字),生产已绕过 |
| MetaGPT | 向量 LTM 去重 | 概念好但主线禁用(`enable_memory=False`)|
| AutoGen | actor-runtime / topic-subscription | 解决了你已解决的问题,是倒退 |
| AutoGen | Selector LLM 选 speaker | 等价你的 PM 调度,多烧一次 LLM 调用 |
| ChatDev | 文档版本 | 就地覆盖无历史;你的版本化文件更优 |
| langflow | 整体采用 | 1516 行 flowStore + React 19 单体,嵌入 vanilla JS 不可行 |
| OpenHands | Git-based workspace | 不存在(其 git 仅用于浏览源,非快照)|

---

## 关键证据指针

- LangGraph checkpoint: `langgraph/libs/checkpoint/.../base/__init__.py:176`, sqlite `checkpoint-sqlite/__init__.py:142`, postgres `checkpoint-postgres/__init__.py:85`
- OpenHands event log: `OpenHands/openhands/app_server/event/event_service_base.py:83-89,190-197`
- OpenHands cost schema: `OpenHands/openhands/app_server/app_conversation/sql_app_conversation_info_service.py:89-103`
- MetaGPT dependency DAG: `MetaGPT/metagpt/utils/dependency_file.py:20-95`, `metagpt/utils/file_repository.py:46-89`
- AutoGen termination: `autogen/python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py:235,358,404`
- AutoGen MagenticOne stall: `autogen/.../teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py:394-406`
- ChatDev edge semantics: `ChatDev/runtime/edge/conditions/base.py:91-176`
- langflow node badge: `langflow/src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx:396-460`

---

*调研日期 2026-06-23。代码 clone 在 `/Volumes/CodexMac/oss-research/` 可查阅。*
