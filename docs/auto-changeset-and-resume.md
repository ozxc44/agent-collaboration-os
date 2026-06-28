# 补充交付:auto-changeset + 跨会话接续

> 接续主 Agent PM 功能报告(`docs/main-agent-pm-feature.md`)之后的两个增量。全部测试通过、部署上线、线上端到端验证。

## 一、任务 1:complete 时自动建 changeset(验收+合并闭环)

### 问题
原方案 worker 完成 task 后,需要手动 `POST /changesets` 才能让主 agent review+merge——多一步,容易漏。

### 实现
`backend/src/routes/orchestrations.routes.ts`:
- complete handler 事务内,当 `nextStatus === ready_for_review` 时,调 `createTaskCompletionChangeset(manager, ...)` 自动建一条 changeset:
  - `orchestrationId`/`taskId` 关联(主 agent 才能 review+merge)
  - `createdByAgentId = worker`(worker 是 author)
  - `fileOps` 引用 RESULT.md,带 `base_revision_id`(merge 不冲突)
  - `resultPath`/`evidencePath` 指向 legacy workers 文件
  - `status = submitted`(主 agent 直接能 review)
  - 懒创建 default branch(新项目无分支时自动建 main)
- **best-effort**:changeset 失败不影响 complete 主流程(catch + log)
- 测试:`task-complete-auto-changeset.test.ts` 13/13(worker complete→changeset 自动建→pm review→merge→task approve,全闭环)
- **线上实测**:dispatch→complete→changeset 自动出现(submitted, task-linked)✅

### 全量验收闭环(现在全自动)
```
worker: POST .../tasks/:tid/complete (result_md)
  → 平台自动建 changeset (submitted, linked to task)
main agent: PATCH .../changesets/:csid/review {decision:approved}
main agent: POST .../changesets/:csid/merge
main agent: PATCH .../tasks/:tid/review {decision:approved}
  → 任务完成,产出合入项目空间
```

## 二、任务 2:本地终端 agent 跨会话身份持久化 + 自动接续

### 场景
本地终端 agent 加入项目后,**新建终端窗口**,能否继续以已有身份登录并自动接续未完成工作?

### 现状(调研结论)
- ✅ **身份持久化已就绪**:identity.json 的 `agent_key` 永久有效(无过期),CLI `_get_agent_client()` 自动从身份文件/config/env 恢复。**新终端无需重新登录。**
- ✅ 心跳:`zz agent watch` 已有
- ❌ **缺任务发现**:后端 `GET /v1/agent/assigned-tasks` 有(我之前加的),但 SDK 和 CLI 都没接
- ❌ **缺启动即接续**:没有任何命令启动时查「我有未完成 task」
- ❌ 缺 `zz agent inbox`(README 宣称有但未注册)

### 实现

**SDK**(`sdk/python/zz_agent/client.py`):
- 新增 `client.agent.assigned_tasks(status=None) -> list[OrchestrationTask]`,调 `GET /v1/agent/assigned-tasks`。复用现有 `OrchestrationTask` 模型。

**CLI**(`cli/zz_cli/main.py`),新增 2 个命令:
1. **`zz agent resume [--claim/--no-claim]`** —— 核心命令:
   - 调 `assigned_tasks()` 查服务器侧未完成任务
   - 写本地 state(`_write_task_state`,OrchestrationTask.id→task_id 适配 shim)
   - 对 `running` 状态的幂等 re-claim
   - 打印待办清单(标题/状态/goal/返工说明/task+context 文件路径)
   - 空 state 友好提示("all caught up, run watch")
2. **`zz agent inbox [--all/--unread] [-n]`** —— 补齐 README 宣称的命令,独立查 inbox。

### 跨会话接续流程(端到端验证通过)
```bash
# 新终端窗口(无需 zz login,身份文件自动加载)
zz agent resume          # 查未完成任务 + 写本地 state
zz agent claim-next      # 从本地 state 恢复 claim
# ... 干活,读 task/context 文件 ...
zz agent submit --result "# Done"   # 提交
zz agent inbox           # 看通知
```

### 线上端到端验证(实测)
- 新 shell → `zz identity status` 读出身份(无需登录)✅
- `zz agent resume` 找到 dispatched task + 写 state + 打印 todo ✅
- `zz agent claim-next` 成功 claim ✅
- `complete` → **auto-changeset 自动建** ✅
- `inbox` 正常 ✅

### 关键文件
- `sdk/python/zz_agent/client.py`(`assigned_tasks` 方法)
- `cli/zz_cli/main.py`(`resume` + `inbox` 命令,在 claim-next 之后)
- 后端 `agent-inbox.routes.ts` 的 `GET /v1/agent/assigned-tasks`(阶段2 已加)

## 三、验证汇总
- 后端 `npm test`:**48/48 套件通过**(auto-changeset +1)
- SDK/CLI:Python 语法检查通过,2 命令注册验证
- 本地↔NAS:SDK/CLI/orch.routes 3 文件 SHA256 一致
- 线上端到端:resume→claim→complete→auto-changeset→approve 全链路实测

## 四、部署
- backend:`orchestrations.routes.ts` 已重建镜像+重启
- SDK/CLI:纯 Python,rsync 覆盖即可(NAS 上 `pip install -e` 更新生效;用户本地 `pip install -e cli sdk/python` 或 PYTHONPATH 运行)

## 五、用户使用
1. **首次加入**:走 agent-start.html bootstrap,生成 identity.json(含 agent_key)。
2. **之后任何新终端**:`zz agent resume` 即可接续,**无需重新登录**(agent_key 永久)。
3. 主 agent 派任务给你 → `resume` 发现 → `claim-next` → 干活 → `submit`。
4. 你的产出自动建 changeset → 主 agent review+merge。

## 六、已知限制
- 无 daemon 模式:watch 是前台进程。要常驻需 launchd/systemd/nohup(文档化即可,非阻塞)。
- Python 3.10+ 推荐(CLI 用了 `X | None` 语法;3.9 用 `from __future__ import annotations` 可跑,但建议升级)。
