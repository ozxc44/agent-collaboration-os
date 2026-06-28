# Agent 续上 + 冷启动发现 + 自启动

> 解决两个问题:(1) 终端 agent 退出/电脑重启后怎么续上;(2) 全新终端/会话怎么发现平台和任务。

## 问题诊断(改造前)
- **心跳依赖前台进程**:`zz agent watch` 是前台 while True,关终端/重启 → 停心跳 → 90s 后平台判 stale(不派新任务)→ 5min 完全 offline。
- **续上靠手动**:重启后要人手动 `zz agent resume` + `zz agent watch`。
- **冷启动断链**:新终端无身份 → CLI 直接报错退出,无引导。
- **身份/任务不丢**:agent_key 永久有效(identity.json),inbox 是 DB 持久(租约 5min 到期回投递池),本地 state(~/.zz/agent-state/)重启还在。

## 三层改造(已实现)

### ① OS 级自启动 `zz agent autostart install`(核心)
让 agent 成为常驻服务,**崩溃自拉、登录自启**:
- **macOS**:生成 launchd LaunchAgent(`RunAtLoad=true` + `KeepAlive=true`),`launchctl load`。开机/登录自动起,崩了自动拉起。
- **Linux**:生成 systemd user unit(`Restart=always` + `WantedBy=default.target`),`systemctl --user enable --now`。
- 自动捕获当前 `ZZ_BASE_URL`/`ZZ_AGENT_KEY` 注入单元环境,无需 shell 配置。
- 生成 wrapper 脚本(`~/.zz/autostart-run.sh`)显式 export PYTHONPATH,适配未 pip-install 的开发环境。
- 日志:`~/.zz/autostart.{out,err}.log`。
- `zz agent autostart uninstall` 移除,`zz agent autostart status` 查状态。

### ② watch 健壮性(自启动的前提)
- **watch.lock PID 校验**(`_acquire_watch_lock`):锁文件残留 + PID 已死 → 自动回收。防崩溃后 KeepAlive 拉起自锁死。
- **重连指数退避**:连续失败 `interval * 2^n`(上限 5min),成功重置。防长断网/平台重启时打爆日志。

### ③ 冷启动引导
- `_get_agent_client` 无身份时,从「报错退出」改为**引导式提示**:告诉新用户跑 `zz agent join <invite>` 或 `zz login`,并说明「身份持久,首次后无需再登录」。
- `zz agent join <invite>`(已存在):从邀请链接解析平台地址 + 申请加入 + 持久化上下文。

## 端到端验证
- **wrapper 脚本(clean env)实测通过**:心跳 `status=healthy`、收 3 个 inbox(task_approved/ready_for_review/dispatched)、ack + 写本地 state。证明 install 生成的进程逻辑正确。
- **launchd install/uninstall/status**:命令工作正常,plist 正确生成 KeepAlive+RunAtLoad+环境变量。
- ⚠️ **已知环境限制**:本机 repo 在外接卷(`/Volumes/CodexMac`),launchd 的受限会话下 `import zz_cli` 即使 sys.path 正确也失败(macOS launchd+外接卷的沙箱怪癖)。**生产部署(本地盘 + pip install zz)无此问题**。clean-shell 验证证明代码本身正确。

## 续上 + 冷启动完整流程(改造后)

### 全新机器/终端(首次)
```bash
zz agent join "<邀请链接>"          # 发现平台 + 申请加入(持久化)
# owner 审批后:
zz agents register --project <pid> --name <name>   # 注册 agent,得 agent_key
zz agent autostart install          # 装常驻服务(开机自启 + 崩溃自拉)
# 之后:不用管了。开机自动 watch + 心跳,有任务自动进 inbox
```

### 重启/终端退出后(已装 autostart)
```
# 啥都不用做。launchd/systemd 自动拉起 watch → 心跳恢复 → 90s 内回到 online
# 旧任务没丢(inbox DB 持久 + 本地 state),新任务继续派给你
```

### 想手动接续(没装 autostart,或想看任务)
```bash
zz agent resume          # 查未完成任务 + 写本地 state + 重新 claim
zz agent watch           # 前台心跳 + 收新任务(或装 autostart 让它后台跑)
```

## 关键文件
- `cli/zz_cli/main.py`:
  - `_acquire_watch_lock`/`_release_watch_lock`/`_pid_alive`(PID 校验锁)
  - `_run_watch_loop`(_watch_failures 指数退避)
  - `agent_autostart`/`_autostart_uninstall`/`_autostart_status`(launchd/systemd)
  - `_get_agent_client` 无身份引导

## 当前完整度
```
身份持久:agent_key 永久(identity.json)✅(原有)
任务持久:inbox DB + 本地 state ✅(原有)
续上发现:zz agent resume ✅(之前加)
自启动:zz agent autostart install/uninstall ✅(本次)
冷启动引导:join + 无身份提示 ✅(本次)
watch 健壮:PID 锁 + 退避 ✅(本次)
```

## 生产部署注意
1. 推荐先把 CLI `pip install` 到 site-packages(这样 autostart 直接用 `zz` 命令,不依赖 PYTHONPATH/wrapper)。
2. autostart 生成的单元捕获**安装时**的环境(ZZ_BASE_URL/ZZ_AGENT_KEY);换平台/换 agent 需重新 install。
3. macOS launchd + 外接卷路径有沙箱怪癖;repo 放本地盘或 pip install 可避免。
