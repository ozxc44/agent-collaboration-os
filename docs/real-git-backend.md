# 真 Git 后端(isomorphic-git)— 实现与部署

> 用户目标:「做成支持 git 的方式」。之前 repo 里的「Gitea parity」全是 DB 模拟的 UI 对齐(batch31-106),没有任何真 git。本次引入真 git 后端。

## 设计决策(用户确认)
- **真 Git 后端**(非 DB 模拟、非外部 Gitea 依赖)
- **纯 JS isomorphic-git**(无需外部 git/gitea 服务)

## 与之前「Gitea parity」的区别
- 之前(batch31-106):DB 模拟 git 语义——branch/commit/revision 全在 Postgres 表,parity matrix 多处写明「no fake clone/archive/provider controls」,即「看起来像 git 但不是 git」。
- 现在:每个项目一个真 `.git` 仓库,merge 产生真 git commit(40-hex SHA),内容存真 git blob,`git log` 读真历史。

## 实现分阶段(双写过渡,DB 仍权威,git 逐步接管)

### 阶段 0:写入收敛(不改行为)
- `utils/content-hash.ts`:统一 4 份重复的 sha256。
- `services/project-file.service.ts`:**收敛 5 套重复 upsert 为一个 `upsertProjectFileContent`**(versioning W1、orchestrations W3、md-artifact W4 已改为调它;project-space W2 保留独立因有乐观锁/分支保护 guard)。这是 git 双写的唯一挂载点。
- 验证:`npm test` 48/48 不变。

### 阶段 1:真 git 后端
- **依赖**:`isomorphic-git@1.27.1`
- **`services/project-git.service.ts`**(新文件):
  - 每项目一个 git 仓库在 `${PROJECT_GIT_DIR}/<projectId>`(默认 `./project-git`)
  - `ensureProjectRepo`(lazy init)、`gitAddFile`、`gitRemoveFile`、`gitCommit`(返回真 SHA)、`gitReadBlob`、`gitLog`、`gitHeadSha`
  - 平台统一 author(Agent Platform),provenance 记在 DB commit + message
- **DB schema**:`ProjectCommit.gitSha` 列(varchar 40, nullable)+ migration `1782600000000-AddProjectCommitGitSha`
- **双写挂载点**:
  - `mergeChangeset`(versioning.routes.ts):DB commit 后,按 changeset.fileOps 执行 git add/rm + gitCommit,回填 `gitSha`。best-effort(失败不影响 DB merge)。
  - `upsertProjectFileContent`(project-file.service.ts):DB 写后 gitAddFile(直接写也进 git)。
  - `softDeleteProjectFile`:DB 软删后 gitRemoveFile。
- **新端点** `GET /v1/projects/:project_id/git/log`:返回 `backend: isomorphic-git` + HEAD sha + 真 commit 历史(author/message/parent/timestamp)。

## 测试
- `tests/git-backend.test.ts` **15/15**:
  - merge → 真 40-hex git SHA
  - git log sha == commit.gitSha
  - git blob 内容 == 交付物
  - 第二次 merge → 父 commit 链正确(parent = 第一个 sha)
  - GET /git/log 返回 isomorphic-git backend + 历史
- 全量 `npm test`:**49/49**(+1)

## 部署 + 持久化
- backend 镜像重建(npm ci 安装 isomorphic-git)+ 重启
- **关键:持久化卷**——`docker-compose.yml` 加 `PROJECT_GIT_HOST_DIR:/data/project-git` bind-mount,git 仓库存到 NAS 磁盘 `/data/zz-agent-platform/project-git/`,容器重建不丢
- migration 自动跑(boot 时 migration:run)

## 线上端到端验证(definitive)
```
✅ merge 产生真 git SHA: 92629a385dfe9c24e873151d9a7b7e5692450be6
✅ GET /git/log → backend: isomorphic-git | HEAD: 92629a38... | 1 commit
   92629a38 | Agent Platform | Merge changeset ce036554...
✅ .git/HEAD 存在 NAS 磁盘(持久化)
✅ 交付物内容在真 git working tree
```

## 关键文件
- `backend/src/services/project-git.service.ts`(新)
- `backend/src/services/project-file.service.ts`(新,写入收敛 + git 双写)
- `backend/src/utils/content-hash.ts`(新)
- `backend/src/migrations/1782600000000-AddProjectCommitGitSha.ts`(新)
- `backend/src/entities/project-commit.entity.ts`(+gitSha 列)
- `backend/src/routes/versioning.routes.ts`(merge 双写 + /git/log + serializeCommit git_sha)
- `backend/src/routes/orchestrations.routes.ts`、`services/md-artifact.service.ts`(改调共享 upsert)
- `backend/tests/git-backend.test.ts`(新)
- `deploy/nas/docker-compose.yml`(+PROJECT_GIT_DIR env + volume mount)

## 当前架构(DB 权威 + git 真后端,双写)
```
写文件(upsert)    → DB ProjectFile/Revision  +  git add
merge changeset   → DB ProjectCommit(snapshot) + git commit(真 SHA 回填 gitSha)
读历史            → /git/log 读真 git log(/files 仍读 DB,过渡)
持久化            → DB(Postgres) + git repo(NAS 磁盘 /data/.../project-git)
```

## 后续(阶段 2/3,未做,按需推进)
- 阶段2:读切换——`resolveProjectBranchContext`、compare、blame 改读 git tree/diff(`is_git_blame: false` 可升级为真 git blame)
- 阶段3:切权威——merge 乐观锁改 git update-ref 原子 CAS;DB content 列降级为可选,git 成内容权威
- 真三方合并:目前 git commit 是 fast-forward 式(单线 parent 链);分支多线合并需阶段2 的 readTree + 三方合并

## 用户验证方式
```bash
# 1. 创建项目 + changeset + merge(任意方式)
# 2. 读真 git 历史:
curl $BASE/v1/projects/$PID/git/log -H "Authorization: Bearer $JWT"
# → backend: isomorphic-git, head: <40hex>, data: [{sha, message, author}]
# 3. git 仓库在 NAS 磁盘:
ls /data/zz-agent-platform/project-git/<projectId>/.git/
```
