# AGENT.md — agent-watchdog

本文件是 agent 在本仓库开发时必须遵守的约定。

## 仓库定位

**独立服务监督控制面**：从部署平台 `:4220` 对账本机监督名单，探活其它服务并在 DOWN 时自愈。
默认监督控制面首批服务（`agent-control-plane` / `service_registry` / 部署平台 / brain / gateway）；加服务改部署契约或 `WATCHDOG_SYNC_ALLOW`，不要改引擎。

边界（不要越界）：

| 路径 / 仓库 | 角色 | agent 可否改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | 本 task 独立工作区（唯一开发目录） | 是 |
| 本仓库 GitHub `gitRepoUrl` | origin：clone / push / PR | 否（只读，仅作 remote） |
| `~/runtime/agent-watchdog` | 本服务安装目录（`:4230`、sqlite） | 否（install.sh 产物） |
| [`kaulie/agent-control-plane-deployment`](https://github.com/kaulie/agent-control-plane-deployment) | 部署控制面（`:4220`）——不同仓库 | 否（除非用户明确要求改部署） |
| `~/runtime/web-cursor`、`deployment-<hash>/` 快照 | 被监控应用与发版产物 | 禁止手改 |

## 核心设计约束（改动前必读）

1. **契约驱动**：探活/自愈参数都在 `services` 契约里；新增服务**不要**改引擎，加契约即可。
2. **探针与自愈必须“永不抛异常”**：`health.ts` / `remediation.ts` 永远 resolve，错误转成结果对象，避免引擎被单个服务拖垮。
3. **自愈闸门不可绕过**：pause → cooldown → rate limit → in-flight 去重，四道闸门是历史故障（重启风暴 / EADDRINUSE）的修复，改动需配套测试。
4. **pause 兼容旧发版标记**：`<WATCHDOG_LEGACY_DEPLOY_DIR>/<serviceId>/ops/watchdog-pause-until` 必须继续被识别。
5. **独立进程**：不要在其它服务的进程/目录里同步执行本服务的启停；也不要让本服务同步重启它自己。

## 开发流程

本仓库目前没有 `project_map/`；目录和操作说明见 `README.md`。
Dashboard 在 `/dashboard`，实际探测历史独立存于 `health_checks`，不要用审计事件或状态迁移替代。
2026-10-09 只读核对部署平台 `/api/services`：本仓库对应的 service ID 是 `watchdog`，
`gitRepoUrl=https://github.com/kaulie/agent-watchdog`，`defaultBranch=main`，配置端口为 **4235**。
下文 **4230 是代码默认值**，访问实际部署时以平台契约和运行健康检查为准。
运行平台的端口配置与默认值不同，不应据此修改默认配置。

1. 在 task workspace 改代码，本地自测（`npm run typecheck` + `npm test`）。
2. 端口用 **4230**；本地自测为避免冲突可换端口（例如 `SERVICE_PORT=4239` 或 `WATCHDOG_PORT=4239`）。
3. `git commit` → `git push -u origin HEAD` → `gh pr create`，回写 `prUrl`。
4. **不要** merge PR、不要擅自 `release.sh` / `deploy.sh`（除非用户明确要求）。

## 质量门

- `npm run typecheck` 必须通过。
- `npm test` 必须全绿；新增引擎/策略行为需补 `test/engine.test.ts` 用例。
- 发版包：`./build.sh` 生成 `outputs/`（含 `dist/` 与生产依赖）。

## 安全

- 只监听 `127.0.0.1`，API 无鉴权，不要暴露公网。
- 不提交 `node_modules/`、`dist/`、`outputs/`、`data/`、`logs/`、`*.pid`、密钥。
