# agent-watchdog

**独立服务监督控制面（independent service supervision control plane）。**

一个与业务应用、与部署控制面都**完全解耦**的常驻服务：按注册表（service
registry）持续探活其它服务，驱动一个小型状态机，并在服务 DOWN 时按契约执行
自愈（start / restart）。当前默认只托管 **web-cursor**，但架构上以「注册表 +
可插拔探针」实现，新增被监控服务只是**加一条契约数据**，不需要改代码。

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
                    │ web-cursor runtime  (HTTP :4211)      │
                    │ ~/runtime/web-cursor/scripts/*.sh     │
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

> 当前范围：仅托管 `web-cursor`（首个 seed 契约）。多服务能力已经具备，追加服务见下文「新增被监控服务」。

## 概念模型

### Service contract（服务契约）

契约是**探活方式 + 自愈方式 + 策略**的唯一真源：

| 字段组 | 字段 | 说明 |
|---|---|---|
| 标识 | `serviceId` `name` `group` `enabled` | `enabled=false` 时既不探活也不自愈 |
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
  seed.ts       注册表 seed（web-cursor + 可选 JSON seed 文件）
  index.ts      进程启动 / 优雅退出
test/           node:test 单元测试（契约 / 存储 / 引擎 / pause）
scripts/        start.sh stop.sh restart.sh status.sh（运行时启停）
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
```

开发：

```bash
npm install
npm run typecheck
npm test            # node:test，19 个用例
npm run dev         # tsx watch
```

## REST API

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
| GET | `/api/stats` | 聚合统计（registry + 各状态计数） |

示例：

```bash
# 立即探活 web-cursor
curl -sS -X POST http://127.0.0.1:4230/api/services/web-cursor/probe

# 发版期间暂停 web-cursor 的自愈（2 分钟）
curl -sS -X POST http://127.0.0.1:4230/api/pause \
  -H 'content-type: application/json' \
  -d '{"seconds":120,"reason":"deploy","serviceId":"web-cursor"}'

# 手动拉起
curl -sS -X POST http://127.0.0.1:4230/api/services/web-cursor/remediate \
  -H 'content-type: application/json' -d '{"action":"restart"}'
```

## 新增被监控服务

**方式 A — API（运行时热加）**：

```bash
curl -sS -X PUT http://127.0.0.1:4230/api/services/my-api \
  -H 'content-type: application/json' -d '{
    "name": "My API",
    "group": "apps",
    "probeType": "http",
    "probeTarget": "http://127.0.0.1:4301/health",
    "expectStatus": 200,
    "intervalSec": 15,
    "remediation": "restart",
    "runtimeDir": "/Users/gaolei/runtime/my-api",
    "restartCmd": "bash scripts/restart.sh",
    "failureThreshold": 3,
    "cooldownSec": 90,
    "maxRemediationsPerHour": 4
  }'
```

**方式 B — 声明式 seed（首次启动导入）**：把 `WATCHDOG_SEED_FILE` 指向一个
JSON 数组（元素为部分契约），启动时按需写入/更新，不需要改代码。

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
`WATCHDOG_LOG_LEVEL`。

## 安全

- 只监听 `127.0.0.1`；API 无鉴权，**不要**暴露到公网。
- 自愈只会执行契约里显式配置的命令，命令以 `/bin/bash -lc` 在 `runtimeDir` 下运行，超时按进程组杀树。
- 不保存任何密钥；数据库仅含契约、状态、审计事件与自愈输出（截断）。

## 与旧实现的关系（迁移状态）

- 本服务**取代**部署侧 shell `ops/watchdog.sh` 的职责（探活 + 拉起），并保留对其 `watchdog-pause-until` 标记的兼容读取。
- 部署服务进程内的 `Watchdog` 类可切换到「只做部署」、由本服务专责监控（切换属部署仓库改动，另行进行）。
- web-cursor runtime 内 `scripts/watchdog.sh` 仍标注 DEPRECATED，属应用自带的应急副本。

