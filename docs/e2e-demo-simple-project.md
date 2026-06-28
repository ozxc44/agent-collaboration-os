# 端到端验证:简单项目全 PM 循环

> 在 LAN 平台(`<your-platform-host>:18080`)上用真实账号 + 真实 agent 跑通「主 agent 统筹一个简单项目」的完整闭环。脚本:`/tmp/e2e_pm_demo.sh`。

## 端到端流程(11/11 通过)

| # | 步骤 | 验证 | 结果 |
|---|------|------|------|
| 1 | 注册 PM + worker agent | api_key 返回(zzk_+64hex=68) | ✅ |
| 2 | 心跳(两个 agent dispatchable) | heartbeat 200 | ✅ |
| 3 | 设 PM 为 project main agent + 通知 | `promoted_to_main_agent` inbox 送达 | ✅ |
| 4 | PM 写 AGENTS.md(主 agent 写例外) | path=AGENTS.md | ✅ |
| 5 | PM 建 orchestration + 派任务给 worker | orch + task id 返回 | ✅ |
| 6 | worker 通过 `/assigned-tasks` 发现任务 | task 在列表中 | ✅ |
| 7 | worker claim + complete | status=ready_for_review | ✅ |
| 8 | **complete 自动建 changeset**(关联 task) | changeset id 返回,task_id 匹配 | ✅ |
| 9 | PM review(approved)+ merge changeset | changeset.status=merged | ✅ |
| 10 | PM approve task | task.status=approved | ✅ |
| 11 | (CLI)新终端 `zz agent resume` 发现任务 | resume 打印 todo | ✅ |

## 跨会话接续(真实 CLI 验证)
新建 worker agent + 派未完成任务 → 新 shell(用持久 identity 文件,**不重新登录**)→
`zz agent resume`:
- 读身份文件 agent_key(永久有效)
- 查 `/v1/agent/assigned-tasks`
- 找到 dispatched task + 打印 task/context 文件路径
- ✅ 跨会话身份持久化 + 任务发现 全通

## 全自动验收闭环(现在 worker 零额外操作)
```
PM: POST .../tasks/:tid (assigned_agent_id)
worker: GET /v1/agent/assigned-tasks → 发现
worker: POST .../tasks/:tid/complete (result_md)
  → 平台自动建 changeset (task-linked, submitted)
PM: PATCH .../changesets/:csid/review {approved} + POST .../merge
PM: PATCH .../tasks/:tid/review {approved}
  → 任务完成,产出合入项目空间
```

## 回归
- `npm test`:**48/48 套件通过**,exit 0
- frozen-surface guard:**PASSED**(source/manifest/freeze-doc/matrix 一致,25 routes)
- 本地↔NAS:所有改动文件 SHA256 一致

## 发现并修复的问题(e2e 中)
1. CLI `_write_task_state` 读 `task_id` 但 `OrchestrationTask` 用 `id` → 加 shim 适配(OrchestrationTask.id→task_id)。已在 resume 命令修复并验证。
2. (无后端异常)e2e 全程无 500,所有端点行为符合预期。

## 简单项目实证
项目 `demo-simple-2`(public)上,一个 PM agent(demo-pm)+ 一个 worker agent(demo-worker),PM 派一个任务(build-feature),worker 完成,平台自动建 changeset,PM review+merge+approve —— **从设主 agent 到任务合入,全自动化,无需任何手动建 changeset 步骤**。

## 用户可复现
```bash
# 在 NAS 上,作为项目 owner:
# 1. 设主 agent
curl -X PATCH $BASE/v1/projects/$PID -H "Authorization: Bearer $JWT" \
  -d '{"main_agent_id":"<pm_agent_id>"}'
# 2. 主 agent 用 X-API-Key 派任务 / worker 用 /assigned-tasks 收 / complete
# 3. 平台自动建 changeset,主 agent review+merge
```
