# 读路径切换到真 Git(阶段2)

> 接续 `docs/real-git-backend.md`(写)+ `docs/git-backend-cli-sdk.md`(客户端)。本篇:把「读」也从 DB snapshot 切到真 git(带严格兜底)。

## 切换策略:gitSha 判空 + DB 兜底
**核心原则**:branch HEAD 的 DB commit 有 `gitSha`(40-hex) → 走真 git 读;否则落回 DB snapshot。
gitSha 缺失场景:git 后端上线前的旧 commit、rollback 产生的新 commit、merge 时 git 写失败被吞。
**所有读路径都带兜底,git 读失败/空 → 自动回 DB,不会让读端点报错或返空。**

## 切换的读路径(4 个)

| 路径 | 切换前(DB) | 切换后(真 git) | 兜底 |
|------|-----------|---------------|------|
| **files?branch=main**(文件列表) | commit.snapshot 的 path key | `gitListTreeFiles(gitSha)` 读真 git tree | git tree 空 → snapshot |
| **raw?branch=main**(文件内容) | ProjectFileRevision.content | `gitReadBlobRaw(path, gitSha)` 读真 git blob | 二进制/无 gitSha → revision |
| **blame?branch=main** | DB revision 行归因 | 保留 DB 行归因 + **新增 `git_last_commit`**(真 git 最后改该文件的 commit) | 无 gitSha → 不加 git 字段 |
| **resolveProjectBranchContext**(底层) | snapshot path 集合 | 优先 git tree path 集合 + 暴露 `gitSha` 字段 | git 空 → snapshot |

## 新增 git 服务函数(`project-git.service.ts`)
- **`gitListTreeFiles(projectId, oid)`** — 递归读 git tree,返回所有文件路径。替代 snapshot 的 path key。
- **`gitReadBlobRaw(projectId, path, oid)`** — 二进制安全的 git blob 读取(Buffer)。raw/download 用它,避免 utf8 损坏二进制。

## 关键改动
- `project-space.routes.ts`:
  - `resolveProjectBranchContext`:加 `gitSha` 字段;`snapshotPaths` 优先 `gitListTreeFiles`。
  - `resolveProjectFileRawContent`:branch 模式优先 `gitReadBlobRaw`(二进制安全)。
  - blame 路由:加 `git_last_commit` 元数据(commit.gitSha 有时)。
- `versioning.routes.ts`:已带 gitSha(写阶段就回填)。

## 修复的 bug(顺带)
**branch 查询 uuid 注入**:`resolveProjectBranchContext` 的 `where: [{name:branchParam},{id:branchParam}]` 在 `branchParam=main`(非 uuid)时,Postgres 报 `invalid input syntax for type uuid: "main"` → 所有 `?branch=main` 读取 500。
修复:加 `looksLikeUuid` guard,非 uuid 形状只按 name 查。**这是个潜伏 bug,读切换让它暴露,现已根治。**

## 线上端到端验证(实测)
```
files?branch=main  → ✅ 5 files(从真 git tree)
raw?branch=main    → ✅ git blob 内容(goal.md)
blame?branch=main  → ✅ git_last_commit sha: f7a0117c16dc(真 git commit)
git/log            → ✅ isomorphic-git + HEAD f7a0117c
```

## 回归
- git-backend **15/15**、versioning 过、gitea-sync 10/10、file-proposals 50/50、route-guard 3/3、notification-metrics 过
- 66/71 套件过;5 个失败均为**预存在**(project-space synthetic-dirs 是分支工作;e2e/live-load 需活服务器)——**无一是本次引入**
- 本地↔NAS:`project-space.routes.ts` SHA256 一致

## 当前架构(读也走真 git)
```
写:upsert → DB + git add;merge → DB commit + git commit(回填 gitSha)
读?branch:gitSha 有 → 真 git tree/blob;无 → DB snapshot 兜底
读 git/log:始终真 git
持久化:Postgres + /data/.../project-git/(NAS 磁盘)
```

## 还没做(阶段3,按需)
- **merge 乐观锁切 git update-ref 原子 CAS**(目前 DB 乐观锁 + git 双写)
- **git 成内容权威**(DB content 列降级可选)—— 需 backfill 旧数据
- **真三方合并**(目前 fast-forward 单线;多分支合并需 readTree + 三方)
- **行级 git blame**(isomorphic-git 无高层 blame,需自建 walk)—— 当前是文件级 git_last_commit

## 关键文件
- `backend/src/services/project-git.service.ts`(+gitListTreeFiles、gitReadBlobRaw)
- `backend/src/routes/project-space.routes.ts`(resolveProjectBranchContext、resolveProjectFileRawContent、blame、looksLikeUuid 修复)
