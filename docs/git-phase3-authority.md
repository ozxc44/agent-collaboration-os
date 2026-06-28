# 真 Git 阶段3 — git 权威化 + 三方合并基础

> 接续 real-git-backend(写)→ git-read-path-switch(读)→ git-backend-cli-sdk(客户端)。本篇:补全所有写入路径落 git、引入真三方合并原语、修 Postgres 兼容 bug。

## 阶段3 做了什么(5 项)

### 1. rollback 补真 git commit(`versioning.routes.ts`)
- `rollbackToCommit` 建 DB commit 后,事务外补 `gitCommit`(恢复 target tree 整树)→ 回填 `gitSha`。
- 此前 rollback commit 永远 gitSha=null(读路径兜底走 DB)。现在 rollback 也产真 git commit。

### 2. proposal 合并走共享 upsert(`project-space-frozen.routes.ts`)
- proposal 批准原先直接改 `file.content` + 手建 revision,**完全绕过 git**。
- 改为调 `upsertProjectFileContent`(共享写核心),自动镜像到 git index。堵住第 3 个写 content 的旁路。

### 3. gitSha 回填脚本(`backend/src/scripts/backfill-git-history.ts`)
- 遍历每个项目的 `ProjectCommit`(createdAt ASC),对 gitSha=null 的:按 snapshot 逐 path 读 revision 内容 → `gitAddFile` → `gitCommit`(自动串父链)→ 回填 gitSha。
- **幂等**(已有 gitSha 的跳过)。rollback/forward-restore commit 的 snapshot 是整树,直接还原。
- 运行:`node dist/src/scripts/backfill-git-history.js [--project <id>]`(需在容器内,Node 上下文)

### 4. 真三方合并原语(`project-git.service.ts`)
- **`gitMergeBase(oidA, oidB)`** — findMergeBase,返回共同祖先。已用于 branch compare。
- **`gitMerge(theirOid)`** — isomorphic-git 的 `merge()`(内置 **diff3** 行级三方合并!)。best-effort,criss-cross(base>1)抛错被吞→null。
- **关键发现**:isomorphic-git@1.27.1 **自带 diff3**(`merge()`→`_merge()`→`findMergeBase`+`mergeTree`→`diff3Merge`)。题设说「没有 merge 算法」是错的。无需引入第三方 merge 库。

### 5. branch compare 暴露 merge_base_sha(`versioning.routes.ts`)
- `buildBranchCompareResult` 返回新增 `merge_base_sha`(两 commit.gitSha 都有时算)。`main vs main` → 自身。
- 这是真三方 diff 的基础(知道 A/B/C 三点)。

## 修的 2 个 Postgres 兼容 bug(关键!)
1. **branch compare uuid 注入**:`branch.name = :baseRef OR branch.id = :baseRef`,当 `baseRef="main"`(非 uuid)→ Postgres 报 `operator does not exist: uuid = text` → compare 500。加 `isUuid` guard,非 uuid 只按 name 查。**和之前 resolveProjectBranchContext 同源 bug**。
2. **staleness sweep jsonb cast**:`metadata ->> 'stale_notified_at'` 在 Postgres 报 `operator does not exist: text ->> unknown`(simple-json 列是 text,不是 jsonb)。改 `metadata::jsonb ->> '...'`。

## 线上验证(实测)
```
branch compare main vs main → ✅ merge_base_sha: f7a0117c...(真 git merge base,之前 500)
staleness sweep 60s → ✅ 0 errors(之前每次报 jsonb 错)
e2e git 全闭环 → ✅ 11/12(1 个是测试脚本 inline python 故障,非真缺陷)
git/log → ✅ isomorphic-git + 历史
```

## 测试
- `git-threeway-merge.test.ts` **4/4**(merge base 自身/线性祖先/40-hex)
- `git-backend` 15/15、versioning、file-proposals 50/50 全过
- 全量 68/72 过;4 失败全为预存在(project-space synthetic-dirs;e2e/live-load 需活服务器)——**零新增失败**

## 当前真 git 完整度
```
写入(全落 git):
  upsert → DB + git add
  merge changeset → DB commit + git commit(回填 gitSha)
  rollback → DB commit + git commit(回填 gitSha)  ← 阶段3 新增
  proposal approve → DB + git add  ← 阶段3 新增

读取(优先 git):
  ?branch → git tree/blob(gitSha 兜底 DB)
  git/log → 真 git
  branch compare → 真 git merge base  ← 阶段3 新增

三方合并原语就绪:gitMergeBase + gitMerge(diff3)
```

## 还剩(阶段3 收尾,可选)
- **真合并提交触发**:mergeChangeset 现在是 replay+commit(线性)。要让分叉 branch 产真合并提交(两 parent),需在 merge 路由检测 base≠head 后调 `gitMerge`。当前线性历史下 replay 已正确,合并提交是增强。
- **DB content 列降级为可选**(git 成内容权威):需先迁移 live 读路径(license/search/security),风险评估建议分批。
- **回填脚本纳入 CI/部署**:首次部署后跑一次回填旧 commit。

## 关键文件
- `backend/src/routes/versioning.routes.ts`(rollback git 镜像、compare uuid fix、merge_base_sha)
- `backend/src/routes/project-space-frozen.routes.ts`(proposal 走 upsert)
- `backend/src/services/project-git.service.ts`(+gitMergeBase、gitMerge)
- `backend/src/services/task-staleness-sweep.service.ts`(jsonb cast fix)
- `backend/src/scripts/backfill-git-history.ts`(新,回填脚本)
- `backend/tests/git-threeway-merge.test.ts`(新,4/4)

## 用户验证
```bash
# branch compare 看 merge base(三方 diff 基础)
curl "$BASE/v1/projects/$PID/branches/compare?base=main&head=main" -H "Authorization: Bearer $JWT"
# → data.merge_base_sha: <40hex>

# 回填旧项目(容器内)
docker exec nas-backend-1 node dist/src/scripts/backfill-git-history.js
```
