# 真 Git 后端 — CLI/SDK 客户端层 + 主 agent 合并

> 接续 `docs/real-git-backend.md`(后端真 git 双写)。本篇聚焦用户关心的两点:**worker CLI 怎么用新 git**、**主 agent 怎么合并**。

## 一、worker / PM 现在怎么用真 git

### 新增 CLI 命令(`zz git` 子应用)
- **`zz git log -p <PID>`** — 读项目**真 git 历史**(HEAD sha + 每条 commit 的 message/author)。验证产出真的进了 git。
- **`zz git head -p <PID>`** — 打印 HEAD commit SHA。

### worker 提交产出(不变,但底层已是真 git)
worker 仍用 `zz agent submit` / `zz agent deliver`。**底层链路**:
```
zz agent submit --result "..." 
  → 后端 complete_task 自动建 changeset(关联 task)
  → PM 用 zz changesets approve-and-merge 合并
  → 后端 mergeChangeset 双写:DB commit + 真 git commit(40-hex SHA 回填)
worker 可用 zz git log 看到自己的产出在真 git 历史里
```

## 二、主 agent(PM)怎么合并 — 一键命令

### `zz changesets approve-and-merge <changeset_id> -p <PID>`(新增)
主 agent 一条命令完成「approve + merge」,并打印**真 git commit SHA**:
```
✓ Approved: cb0aca88-...
✓ Merged: cb0aca88-...
  git sha: f7a0117c16dcb006307cc53ae5a91c2ea26c2701  (real commit)
```
等价于原来的两步(review approved → merge),但一条命令、且暴露真 SHA。

### 原 `zz changesets merge` 也已增强:打印 git_sha。
### PM 验证合并: `zz git log -p <PID>` 看到刚才那条 commit。

## 三、SDK 新增(sdk/python/zz_agent/)
- **`client.git.log(project_id, depth=50)` → `GitLog`**:调 `GET /git/log`,返回 `{backend, head, data:[GitLogEntry]}`。
- **`client.git.head(project_id)` → str|None**:HEAD SHA。
- **`ProjectCommit.git_sha`** 字段(新):merge 返回的 commit 现在带真 git SHA(之前被丢弃)。
- **`GitLogEntry` / `GitLog`** 模型(新)。

## 四、端到端验证(线上实测)
```
1. owner 建项目 + 设 PM agent
2. PM dispatch task → worker(PM 自兼)complete → 后端自动建 changeset
3. zz changesets approve-and-merge → ✅ git sha: f7a0117c...(real commit)
4. zz git log → ✅ HEAD: f7a0117c... | Merge changeset cb0aca88... | by Agent Platform
5. zz git head → f7a0117c...
```

## 五、修复的 bug
- SDK `client.git.log()` 误用 `_response_data`(它解包了 `{backend,head,data}` 的 `data` list,丢失 backend/head)→ 改用 `response.json()` 直接拿完整 wrapper。

## 六、关键文件
- `sdk/python/zz_agent/client.py`(`_GitAPI` 类 + `client.git` 挂载)
- `sdk/python/zz_agent/models.py`(`ProjectCommit.git_sha`、`GitLog`、`GitLogEntry`)
- `cli/zz_cli/main.py`(`git_app` 子应用 + `changesets approve-and-merge` + `merge` 打印 git_sha)

## 七、典型工作流(完整闭环)
```bash
# worker(任何终端,身份已持久化)
zz agent resume                    # 接续任务
zz agent submit --result "# Done"  # 提交(后端自动建 changeset)

# 主 agent(PM)
zz changesets approve-and-merge <csid> -p <PID>   # 一键 approve+merge,得真 git SHA
zz git log -p <PID>                                # 验证产出在真 git 历史
```

## 八、部署
- SDK/CLI:rsync 到 NAS `/data/zz-agent-platform/{sdk,cli}/`(纯 Python,覆盖即生效)
- 用户本地:`pip install -e sdk/python cli`(或 PYTHONPATH 运行)
- 后端无需改动(49/49 测试通过)
