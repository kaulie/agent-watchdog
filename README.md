# agent-watchdog

**独立服务监督控制面（independent service supervision control plane）。**

一个与业务应用、与部署控制面都**完全解耦**的常驻服务：从部署平台 `:4220`
拉取本机服务契约，持续探活并在 DOWN 时按契约自愈（start / restart）。
名单以部署契约为准，SQLite 只缓存上次对账结果和运行态；**不要**再靠
`PUT /api/services` 当目录的主入口。

```
                       ┌──────────────────────────────┐
   HTTP :4230          │        agent-watchdog        │
   ──────────────────▶ │  registry · probe · state     │
                       │  · remediation · pause · audit│
                       └───────────────┬──────────────┘
                                       │ probe (http/command)
                                       │ remediate (start/restart via contract)
                                       ▼
                    ┌──────────────────────────────────────┐
                    │ 本机 runtime（agent-control-plane /   │
                    │ registry / brain / gateway / …）      │
                    └──────────────────────────────────────┘
```

## 定位：为什么再抽一层

历史上“看门狗”有三种存在形态，职责互相纠缠：

| 形态 | 位置 | 问题 |
|---|---|---|
| runtime 内 `scripts/watchdog.sh` | 应用仓库，随应用发版 | 与被打的服务同生共死；停止/重启语义靠 `.watchdog-paused` 标记，容易与发版抢 `start` |
| 部署服务进程内的 `Watchdog` 类 | `agent-control-plane-deployment` | 探活与**部署**共进程：部署一重启，监控就中断；两件事互相干扰 |
| 部署侧 shell `ops/watchdog.sh` | `~/deployment/<service>/ops/` | 单服务、纯 shell、无状态、无审计、无退避策略 |

本服务把「监控 + 自愈」独立成一个**有自己的进程、端口、数据库、安装目录和
启停脚本**的服务，并且：

- **与被打服务解耦**：停/起 watchdog 不碰被监控服务；被监控服务发版也不需要动 watchdog。
- **与部署解耦**：部署控制面（:4220）只负责「投递代码 + 重启」；watchdog 只负责「发现不健康 + 拉起」。两者通过 **pause** 协作而不是共进程。
- **注册表驱动**：所有行为都写在 `services` 契约表里，天然支持多服务。
- **有审计**：状态迁移、自愈动作、暂停都落库，可回溯“什么时候谁把服务拉起来的”。

> 默认监督：`agent-control-plane`、`service_registry`、`agent-control-plane-deployment`、`home-agent-brain`、`home-agent-gateway`。另钉住 `acp-upgrader`（command 探针看 `upgrader.pid`，不从 :4220 对账）。用 `WATCHDOG_SYNC_ALLOW` 增减；`*` 表示所有本机已配置服务（仍排除 watchdog 自己和 `acp-upgrader`）。

## 概念模型

### Service contract（服务契约）

契约是**探活方式 + 自愈方式 + 策略**的唯一真源：

| 字段组 | 字段 | 说明 |
|---|---|---|
| 标识 | `serviceId` `name` `group` `enabled` `source` `pinned` | `enabled=false` 时既不探活也不自愈；`source=deploy-sync` 由 :4220 对账；`pinned` 钉住后同步不改 |
| 探针 | `probeType` `probeTarget` `probeTimeoutMs` `expectStatus` `expectBodyContains` | `http`：GET URL，校验状态码/响应体；`command`：shell 命令，退出码 0 = 健康 |
| 节奏 | `intervalSec` | 探活周期 |
| 自愈 | `remediation` `runtimeDir` `startCmd` `restartCmd` `stopCmd` | `remediation` ∈ `start/restart/stop/none` |
| 策略 | `failureThreshold` `successThreshold` `cooldownSec` `maxRemediationsPerHour` | 见下 |

### 状态机（带滞回）

```
probe ok            failure×N(≥failureThreshold)
unknown ──▶ up  ◀───────────────  down
              ▲                     │
              └─────────────────────┘
                success×M(≥successThreshold)      → 触发自愈（若 remediation≠none）
```

- 连续 `failureThreshold` 次失败才判 **down**（避免偶发抖动误重启）。
- 连续 `successThreshold` 次成功才判 **up**（避免半死不活时反复翻转）。
- 状态迁移、自愈动作都会写入 `events` / `remediations`。

### 自愈的四道闸门

即使判 DOWN，也不会无脑重启：

1. **pause**：处于暂停窗口（发版 / 维护 / 手动）时跳过自愈，并记事件。
2. **cooldown**：两次自愈之间至少间隔 `cooldownSec`。
3. **rate limit**：滚动 1 小时内自愈次数不超过 `maxRemediationsPerHour`（防重启风暴）。
4. **去重**：同一服务同一动作并发时只跑一次（in-flight guard）。

### Pause（部署安全）

自愈与「rsync + restart」抢 `start` 是历史故障（EADDRINUSE / 反复重启）的根因。
watchdog 通过三处 pause 来源避免打架（优先级从高到低）：

1. 进程内全局暂停：`POST /api/pause {seconds}`
2. 进程内 + 落盘的服务级暂停：`POST /api/pause {seconds, serviceId}`（落盘到 `data/pause/<id>.until`，重启后仍生效）
3. **兼容旧发版标记**：`<WATCHDOG_LEGACY_DEPLOY_DIR>/<serviceId>/ops/watchdog-pause-until`
   —— 部署控制面在发版期间已经会写这个文件，本服务直接识别，**零改造兼容**。

## 目录结构

```
src/
  config.ts     env / 路径 / 默认策略
  types.ts      领域类型（contract / status / event / remediation）
  db.ts         SQLite 存储（services / events / remediations）
  contract.ts   契约合并、校验、默认值、数值夹取
  health.ts     探针适配器（http / command），永不抛异常
  remediation.ts 命令执行（detached 进程组 + 超时杀树）
  pause.ts      pause 仲裁（全局 / 服务级 / 旧发版标记）
  engine.ts     监控引擎：调度 + 状态机 + 自愈闸门（可注入 probe/remediate，便于测试）
  routes.ts     REST API
  seed.ts       空库 bootstrap + web-cursor → agent-control-plane 迁移
  deploy.ts     拉取 :4220 目录并映射成本机契约
  sync.ts       定时对账（失败保留上次缓存）
  index.ts      进程启动 / 优雅退出
test/           node:test 单元测试（契约 / 存储 / 引擎 / pause / sync）
scripts/        start.sh stop.sh restart.sh status.sh（部署平台 / 人工启停，后台 nohup）
                run-service.sh（LaunchAgent 前台常驻：exec node，勿改成 restart）
install.sh      安装到 ~/runtime/agent-watchdog 并重启
build.sh        生成 outputs/（供部署控制面 release 使用）
```

## 安装 / 启停

```bash
git clone https://github.com/kaulie/agent-watchdog
cd agent-watchdog
./install.sh
# → ~/runtime/agent-watchdog，监听 127.0.0.1:4230

~/runtime/agent-watchdog/scripts/status.sh    # 自身健康 + 各服务状态
~/runtime/agent-watchdog/scripts/stop.sh
~/runtime/agent-watchdog/scripts/start.sh
~/runtime/agent-watchdog/scripts/restart.sh

开机由 LaunchAgent `ai.hermes.agent-watchdog` 跑 `scripts/run-service.sh`
（前台 `exec node`，配合 KeepAlive）。发版仍走部署平台契约的 `restart.sh`。
```

开发：

```bash
npm install
npm run typecheck
npm test            # node:test
npm run dev         # tsx watch
```

## REST API

### 服务健康 dashboard

打开 `/dashboard`，选择服务和最近 1 小时 / 24 小时 / 7 天 / 30 天。
页面展示最新实际探测结果、24 个时间桶的可用率图表及逐次探测列表；点击刷新更新窗口，
每页 100 条，可加载更早记录。最新结果独立于历史筛选；超过两倍探测周期或超时预算
（取较大值）标记过期，禁用服务明确标识，不将旧成功结果当作当前健康保证。

- 口径：成功探测次数 / 总探测次数 × 100%，是**样本可用率**，不是时长加权 SLA。
  手动与定时探测均纳入；使用原始探测结果，不用带滞回的 up/down 状态。
- 边界：`[from, to)`，API 使用整数 epoch 毫秒，页面显示浏览器本地时间。
  24 桶等宽；空桶和空窗口可用率为 `null`，页面显示斜线 / 无数据，绝不记作 100%。
- 独立 SQLite `health_checks` 表在每次探测后写入（不受 `WATCHDOG_RECORD_PROBES` 控制），
  每 300 tick 清理 30 天以前记录；进程停止期间不清理。上线前没有历史，不从状态迁移反推。
- `GET /api/services/:id/health-history?from=<ms>&to=<ms>&before=<id>`：
  默认最近 24 小时，最大窗口 30 天；返回全窗口聚合、最新探测及 `events` / `nextCursor`。
  `before` 只分页事件，不改变聚合；分页沿用同一窗口。非法参数 400，未知服务 404。
- 保留原 `/` JSON 索引。页面无需前端依赖或外部 CDN，随 TypeScript 构建进入发布包。

验证：`npm run typecheck && npm test && npm run build`；`test/dashboard.test.ts`
覆盖服务隔离、时间边界、样本计算、空桶、事件字段、分页、保留期限和引擎写入/持久化。

| Method | Path | 说明 |
|---|---|---|
| GET | `/health` | 自身探活（`version` / `uptimeSec`） |
| GET | `/` | 端点索引 + registry 统计 |
| GET | `/api/services` | 所有契约 + 当前状态 |
| GET | `/api/services/:id` | 单个契约 + 状态 |
| PUT | `/api/services/:id` | 新建/更新契约（部分字段即可，缺省回退到原值/默认值） |
| DELETE | `/api/services/:id` | 注销服务 |
| GET | `/api/state` | 全部服务运行态 |
| GET | `/api/state/:id` | 单服务运行态 |
| POST | `/api/services/:id/probe` | 立即探活一次（`{"remediate":true}` 可顺带自愈） |
| POST | `/api/services/:id/remediate` | 手动自愈（`{"action":"start\|restart\|stop"}`，默认取契约动作） |
| GET | `/api/events` | 审计事件（`?serviceId=&type=&limit=`） |
| GET | `/api/remediations` | 自愈历史（`?serviceId=&limit=`） |
| GET | `/api/pause` | 当前暂停快照（全局 + 各服务） |
| POST | `/api/pause` | 暂停（`{"seconds":120,"reason":"deploy","serviceId":"web-cursor"?}`） |
| DELETE | `/api/pause` | 恢复（`?serviceId=` 只恢复该服务，否则全局） |
| GET | `/api/sync` | 对账状态（upstream / stale / desired / applied） |
| POST | `/api/sync` | 立即对账一次 |
| GET | `/api/stats` | 聚合统计（registry + 各状态计数） |

示例：

```bash
# 看对账结果
curl -sS http://127.0.0.1:4230/api/sync
curl -sS -X POST http://127.0.0.1:4230/api/sync

# 立即探活 agent-control-plane（原 web-cursor，:4211）
curl -sS -X POST http://127.0.0.1:4230/api/services/agent-control-plane/probe

# 发版期间暂停自愈（2 分钟）
curl -sS -X POST http://127.0.0.1:4230/api/pause \
  -H 'content-type: application/json' \
  -d '{"seconds":120,"reason":"deploy","serviceId":"agent-control-plane"}'
```

## 探活名单从哪来

启动后每 30 秒拉 `GET :4220/api/services` + `GET :4220/api/deployment-inventory`，
把「本机已配置、在允许名单、不是 watchdog 自己」的服务 upsert 成契约。
`:4220` 挂了就继续用 SQLite 里上次成功的名单（`stale=true`）。

空库（新装）会先 bootstrap 三条鸡生蛋服务：部署平台、`service_registry`、
`agent-control-plane`（runtime 仍是 `~/runtime/web-cursor`）。旧的
`web-cursor` 行会迁成 `agent-control-plane` 并禁用。

**加服务**：部署契约勾选 `supervise`（P1）后对账会直接纳入；未设该字段时
仍看 `WATCHDOG_SYNC_ALLOW`。还要有 `port` / `healthUrl` / `runtimeDir` /
`startCmd`，且 inventory 含 `machineId=local`。`WATCHDOG_SYNC_ALLOW=*` 监督
所有未显式关闭的本机服务。

**临时钉住**：`PUT /api/services/:id` 带 `"pinned": true`，同步不会覆盖。
未钉住的手动 PUT 下次对账会被部署契约盖掉。

**方式 C — 声明式 seed 文件**：`WATCHDOG_SEED_FILE` 仍可用，适合调试。

## 发版与上线

- 本服务与 web-cursor 一样是**独立服务**：`build.sh` 生成 `outputs/`，可由
  `agent-control-plane-deployment` 的 `release.sh` 打包、经服务契约 rsync 到
  `runtimeDir` 并由契约的 `startCmd` 拉起。
- 上线后核对 `GET http://127.0.0.1:4230/health` 的 `version`。
- 与 web-cursor 部署的配合：部署控制面在 rsync/restart 期间写
  `~/deployment/web-cursor/ops/watchdog-pause-until`，本服务识别为 pause，
  期间不抢 `start`；也可显式调用本服务的 `/api/pause`。

## 端口 / 路径约定

| 用途 | 端口 | 路径 |
|---|---|---|
| web-cursor 应用 | 4211 | `~/runtime/web-cursor` |
| 部署控制面 | 4220 | `~/runtime/agent-control-plane-deployment` |
| **本服务** | **4230** | `~/runtime/agent-watchdog` |

环境变量：`WATCHDOG_HOME`、`WATCHDOG_HOST`、`SERVICE_PORT`（优先）/
`WATCHDOG_PORT`（其次，默认 `4230`）、
`WATCHDOG_DEFAULT_*`（探针/策略默认值）、`WATCHDOG_REMEDIATION_TIMEOUT_SEC`、
`WATCHDOG_RECORD_PROBES`（默认关，开启后每次探活都落库）、
`WATCHDOG_LEGACY_DEPLOY_DIR`（默认 `~/deployment`）、`WATCHDOG_SEED_FILE`、
`WATCHDOG_LOG_LEVEL`、
`WATCHDOG_DEPLOY_URL`（默认 `http://127.0.0.1:4220`）、
`WATCHDOG_SYNC`（默认开）、`WATCHDOG_SYNC_INTERVAL_SEC`（默认 30）、
`WATCHDOG_SYNC_ALLOW`（默认首批 5 个；`*` 全部；空 = 不同步）、
`WATCHDOG_SYNC_EXCLUDE`（额外排除，默认已含 `watchdog`）、
`WATCHDOG_SYNC_BOOTSTRAP`（空库才种）。

## 安全

- 只监听 `127.0.0.1`；API 无鉴权，**不要**暴露到公网。
- 自愈只会执行契约里显式配置的命令，命令以 `/bin/bash -lc` 在 `runtimeDir` 下运行，超时按进程组杀树。
- 不保存任何密钥；数据库仅含契约、状态、审计事件与自愈输出（截断）。

## 与旧实现的关系（迁移状态）

- 本服务**取代**部署侧 shell `ops/watchdog.sh` 的职责（探活 + 拉起），并保留对其 `watchdog-pause-until` 标记的兼容读取。
- 部署服务进程内的 `Watchdog` 类可切换到「只做部署」、由本服务专责监控（切换属部署仓库改动，另行进行）。
- web-cursor runtime 内 `scripts/watchdog.sh` 仍标注 DEPRECATED，属应用自带的应急副本。
