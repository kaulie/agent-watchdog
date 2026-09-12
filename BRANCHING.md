# BRANCHING.md — Trunk-Based Development（agent-watchdog）

面向 agent 的主干开发分支规范：短生命周期分支、独立工作区、尽快 push + PR。

**Agent 默认交付：** `commit` → `git push -u origin HEAD` → `gh pr create` → 回写 PR URL。
除非用户另行指令，**不要 merge 进 `main`**，也不要执行发版 / 上线。

## 标准流程（每 task）

```bash
cd /Users/gaolei/agent-workspace/<taskId>
git clone https://github.com/kaulie/agent-watchdog .   # 目录为空时
git fetch origin
git checkout main && git pull --ff-only origin main
git checkout -b feature/<taskId>        # 缺陷用 fix/<taskId> / issue/<taskId>

# ... 在当前分支开发 ...
npm run typecheck && npm test
git add -A && git commit -m "why ..."
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" \
  --title "..." --body "$(cat <<'EOF'
## Summary
- ...
## Test plan
- [ ] npm run typecheck
- [ ] npm test
EOF
)"
```

- 分支名必须含 task id。
- 不直推 `main`、不 force push `main`。
- 只在当前 task workspace 改动；不改其它 task 目录、不改 `~/runtime/**`。

## 合入后上线（非 agent 默认步骤）

1. GitHub 上把 PR merge 进 `main`。
2. 打包：`./build.sh` → `outputs/`（或经
   `agent-control-plane-deployment` 的 `release.sh` + 服务契约）。
3. 由部署控制面把 `outputs/` rsync 到 `~/runtime/agent-watchdog` 并执行契约 `startCmd`。
4. 探活：`curl http://127.0.0.1:4230/health`，核对 `version`。

## 硬性约束

1. 一 task 一分支一 workspace，分支名含 task id。
2. `main` 只接受经 PR 的合并；agent 不直推。
3. 开发在 workspace；发版在部署域，**禁止**在 `agent-workspace/**` 里跑 release/deploy。
4. 禁止手改 `/Users/gaolei/runtime/**`。
