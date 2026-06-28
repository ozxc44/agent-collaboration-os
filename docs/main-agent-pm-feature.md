# 主 Agent (PM 角色) 完整能力 — 交接报告

> 实施时间:2026-06-27/28 夜班自主推进。全部 5 个阶段完成、测试通过(47/47)、部署上线、线上验证。

## 一、设计决策(用户确认)
1. **授权认项目级** `project.main_agent_id`(设一次,全项目生效)
2. **派发仅定向**:主 agent 指定具体 worker(不做广播池)
3. **改派双通道**:主 agent 手动 reassign + 超时自动标记 stale 通知主 agent
4. **产出走 changeset**:worker 提交 changeset → 主 agent review + merge
5. **规则文件**:主 agent 维护 `AGENTS.md`,自动注入所有 agent 上下文

## 二、五阶段交付清单

### 阶段 1:RBAC 收敛 — 项目级主 agent 获得 PM 特权 ✅
- `orchestrations.routes.ts` `ensureMainAgentOrUser` 认 `project.main_agent_id`(新增 `isProjectMainAgent` helper,带请求级缓存)
- `versioning.routes.ts` `canReviewChangeset` 认项目级主 agent + 不再要求 changeset 必须有 orchestrationId
- `projects.routes.ts` PATCH settings 改 main_agent_id 时发 `promoted_to_main_agent` inbox(含 PM 职责清单)
- 测试:`main-agent-rbac.test.ts` 11/11

### 阶段 2:并行派发 + worker 收任务 ✅
- `agent-inbox.routes.ts` 新增 `GET /v1/agent/assigned-tasks`(纯 X-API-Key,worker 一键查分配给自己的非终态任务,含 goal/acceptance/review 反馈)
- 现有派发链路(assigned_agent_id 定向 + inbox + session message)已满足「仅定向」
- 测试:`task-dispatch-reassign.test.ts` 14/14(派发/隔离部分)

### 阶段 3:无响应改派 ✅
- `orchestrations.routes.ts` 新增 `POST /tasks/:tid/reassign`(仅主 agent;旧 task→CANCELLED + 克隆新 task assign 给新 agent + 通知双方)
- 新增 `task-staleness-sweep.service.ts`:60s sweep,DISPATCHED/RUNNING 超 `TASK_STALE_MINUTES`(默认10)→ 标记 metadata.stale + 发 `task_stale` inbox 给主 agent(只通知不自动取消,人决策)
- `app.ts` 启动 sweep(`startTaskStalenessSweep`)
- 测试:`task-dispatch-reassign.test.ts`(reassign 部分)+ `task-staleness-sweep.test.ts` 5/5

### 阶段 4:验收 + changeset 正式合并 ✅
- 复用 versioning:worker `POST /changesets`(带 orchestration_id/task_id)→ 主 agent `PATCH /changesets/:id/review`(approved)→ `POST /changesets/:id/merge`
- Phase 1 的 `canReviewChangeset` 放宽使项目级主 agent 能 review+merge 任意 changeset
- 任务详情 `GET /orchestration-tasks/:tid` 已暴露 related changesets(PM 知道该 merge 哪个)
- 测试:`main-agent-changeset-merge.test.ts` 8/8

### 阶段 5:AGENTS.md 规则文件 ✅
- `project-space.routes.ts`:主 agent 写 `AGENTS.md` 例外(其他路径仍锁 deliverables/);新增 `GET /agents-rules` 读路由;冻结面同步 24→25 routes
- `session-dispatch.service.ts` + `runtime-adapter`/`runtime-types`:新增 `projectRules`,dispatch 时注入每个 agent 上下文(`project_rules` 字段)
- 测试:`agents-rules.test.ts` 11/11

## 三、改动文件汇总

**Backend(8)**:
- `src/routes/orchestrations.routes.ts`(reassign + isProjectMainAgent + ensureMainAgentOrUser async)
- `src/routes/versioning.routes.ts`(canReviewChangeset 放宽)
- `src/routes/projects.routes.ts`(promoted_to_main_agent 通知)
- `src/routes/project-space.routes.ts`(AGENTS.md 写例外 + agents-rules 路由)
- `src/routes/agent-inbox.routes.ts`(assigned-tasks 端点)
- `src/services/session-dispatch.service.ts`(loadProjectRules 注入)
- `src/services/runtime-adapter.service.ts` + `runtime-types.ts`(projectRules 字段)
- `src/services/task-staleness-sweep.service.ts`(**新文件**)
- `src/app.ts`(启动 sweep)

**测试(5,新增)**:`main-agent-rbac` / `agents-rules` / `task-dispatch-reassign` / `task-staleness-sweep` / `main-agent-changeset-merge`

**冻结面同步**:`scripts/validate-project-space-routes.js`(manifest 24→25)、`docs/api-surface-freeze.md`、`.codex/pm-workers/current-capability-matrix.md`、`backend/tests/project-space-route-guard.test.ts`

## 四、验证
- **`npm test`:47/47 套件通过**,exit 0(原 42,+5 新测试)
- **本地↔NAS:所有改动文件 SHA256 逐字节一致**
- **线上实测**(`/agents-rules` 404 正常、`/assigned-tasks` 200、`/reassign` 路由存在、health ok、sweep 后台运行)
- backend 镜像重建 + 重启 3 次(阶段1+5、阶段2+3+4),每次 migration 通过、server 正常启动

## 五、数据库
- **无新表、无新列、无 migration**。全部复用现有字段(main_agent_id / changeset.task_id / task.metadata JSON)。
- task staleness 用 `task.metadata.stale`(JSON 列已有),CANCELLED 状态启用(枚举早存在,首次写入)。

## 六、用户下一步
1. **设主 agent**(需 owner/admin,member 不能自助):
   ```
   PATCH /v1/projects/<pid>  body: {"main_agent_id":"<agent_id>"}
   ```
   设完该 agent 立刻收到 inbox 任命通知。
2. 主 agent 写 `AGENTS.md`(POST /files, path=AGENTS.md)→ 所有 agent dispatch 自动带上规则。
3. 主 agent 派任务(POST .../tasks with assigned_agent_id)→ worker 通过 `/v1/agent/assigned-tasks` 或 inbox 收到。
4. worker 提交 changeset → 主 agent review+merge。
5. worker 无响应 → 主 agent 调 reassign,或等超时 sweep 通知后决策。

## 七、风险与回滚
- 每阶段独立,可单独回滚(备份在 NAS `/data/zz-agent-platform/source-backups/hermes-backup-20260627-232348/`)。
- RBAC 改动是**扩展非替换**(新增项目级判断时保留编排级 OR 关系),老编排不受影响。
- sweep 只通知不自动取消,不会误杀进行中任务。
- `TASK_STALE_MINUTES` 可调(env),`TASK_STALE_SWEEP_MS` 可调。
