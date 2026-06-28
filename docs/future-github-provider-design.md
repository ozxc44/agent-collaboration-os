# 设计备忘:GitHub/第三方托管接入(模式 B)

> 状态:思路保存,未实现。当前使用模式 A(平台内置项目空间)。
> 创建时间:2026-06-28

## 背景

当前平台有两种文件存储模式:
- **模式 A(已实现)**:平台 DB + isomorphic-git + Gitea 镜像。changeset → 内部 merge → 真 git commit。Gitea 提供外部 clone/push/PR。
- **模式 B(本文档)**:GitHub/第三方平台作为文件权威。Agent 直接在 GitHub 上提 PR、review、merge。

## 为什么记录

用户明确提出这个方向,且技术可行。当前不做,但留好设计,以便后续 session 直接实现。

## 核心思路:ProjectGitProvider 抽象层

```
project.git_provider = "internal" | "github" | "gitea_external"

内部路由根据 provider 选择实现:
  internal  → 现有 DB + isomorphic-git(模式 A,已完成)
  github    → GitHub REST API(模式 B,本文档)
  gitea_ext → 外部 Gitea/Forgejo API(模式 B 变体)
```

### 接口定义(伪代码)

```typescript
interface ProjectGitProvider {
  // 读
  getRepositorySummary(projectId): Promise<RepoSummary>      // 文件树/语言/入口
  getFileContent(projectId, path, ref?): Promise<string>      // 读文件内容
  getCodeGraph(projectId): Promise<CodeGraph>                 // 符号/依赖
  searchCode(projectId, query): Promise<SearchResult[]>       // 语义搜索

  // 写
  proposeChange(projectId, fileOps, branch): Promise<ProposalId>  // 提交修改(branch/PR)
  reviewChange(projectId, proposalId, decision): Promise<void>    // 审核
  mergeChange(projectId, proposalId): Promise<MergeResult>        // 合并
  getHistory(projectId, depth): Promise<Commit[]>                 // 读历史
}
```

### 两个实现

```
InternalGitProvider(已实现):
  getRepositorySummary → 扫 ProjectFile 表
  getFileContent → ProjectFile.content
  proposeChange → 创建 ProjectChangeset(file_ops)
  reviewChange → PATCH /changesets/:id/review
  mergeChange → mergeChangeset + gitCommit(isomorphic-git)

GitHubGitProvider(待实现):
  getRepositorySummary → GET /repos/:repo/git/trees/HEAD + GET /repos/:repo/languages
  getFileContent → GET /repos/:repo/contents/:path
  proposeChange → 在 branch 上改文件 + POST /repos/:repo/pulls(创建 PR)
  reviewChange → POST /repos/:repo/pulls/:num/reviews(approve/request_changes)
  mergeChange → PUT /repos/:repo/pulls/:num/merge
  getHistory → GET /repos/:repo/commits
```

## 模式 B 的具体实现步骤(后续 session)

### 步骤 1:Project 实体加字段
```sql
ALTER TABLE projects ADD COLUMN git_provider VARCHAR(20) DEFAULT 'internal';
ALTER TABLE projects ADD COLUMN git_repo_url VARCHAR(500);  -- github.com/owner/repo
ALTER TABLE projects ADD COLUMN git_token VARCHAR(200);     -- GitHub PAT(加密存储)
```

### 步骤 2:GitHubGitProvider service
新建 `backend/src/services/github-git-provider.ts`:
- 用 `@octokit/rest` 或直接 `fetch` 调 GitHub API
- 实现 `ProjectGitProvider` 接口
- rate limit 处理(5000 req/h,需要缓存 + 退避)

### 步骤 3:路由层适配
在 `project-space.routes.ts` 和 `versioning.routes.ts` 的关键端点加 provider 判断:
```typescript
const provider = getGitProvider(project); // internal | github
if (provider.type === 'github') {
  return githubProvider.getFileContent(project.git_repo_url, path);
} else {
  return internalProvider.getFileContent(projectId, path);
}
```

### 步骤 4:Agent 侧(changeset → PR)
- `proposeChange` 在 GitHub 模式下:
  1. 创建 branch(`agent/<task-id>`)
  2. 对每个 file_op 调 GitHub contents API 修改文件
  3. 创建 PR(`POST /repos/:repo/pulls`)
- `mergeChange` 调 `PUT /repos/:repo/pulls/:num/merge`

### 步骤 5:CLI
```bash
zz repo connect-github --project <pid> --repo owner/repo --token <pat>
zz repo provider --project <pid> --set github
```

### 步骤 6:代码理解适配
- `repository/summary` → GitHub tree API
- `code-graph` → 拉文件内容后用现有 regex 提取
- `search` → 拉文件内容后用现有 TF-IDF

### 步骤 7:Webhook(可选)
GitHub PR 状态变更 → 平台 inbox 通知 PM agent

## 模式 B 的优劣势

### 优势
- ✅ 零迁移成本(用户不用导入代码)
- ✅ 原生 clone/push/PR/LFS/Actions
- ✅ 用户可以在 GitHub 上直接看代码
- ✅ 适合开源/已有 GitHub 项目

### 劣势
- ❌ 依赖外部服务(GitHub 挂了平台文件操作就瘫)
- ❌ API 速率限制(5000 req/h)
- ❌ Agent 不能直接 push(要走 fork/branch/PR,比 changeset 复杂)
- ❌ 代码理解需要先拉文件再分析(比 DB 直读慢)

## 决策记录
- 2026-06-28:用户确认先不做,用模式 A(Gitea 网关已覆盖外部 clone/push 需求)
- 触发条件:当用户有"已有 GitHub 项目想直接让 Agent 协作"的真实需求时,启动本设计

## 相关文件(实现时需要改的)
- `backend/src/entities/project.entity.ts`(+git_provider/git_repo_url/git_token)
- `backend/src/services/github-git-provider.ts`(新建)
- `backend/src/routes/project-space.routes.ts`(provider 路由分发)
- `backend/src/routes/versioning.routes.ts`(changeset→PR 适配)
- `cli/zz_cli/main.py`(+repo connect-github/provider 命令)
- `backend/src/services/session-dispatch.service.ts`(注入 GitHub repo 上下文)
