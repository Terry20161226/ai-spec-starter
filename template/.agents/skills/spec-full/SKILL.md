---
name: spec-full
description: 高风险变更专用完整规划与归档流程（库表迁移、跨服务契约、状态机重构、权限模型变更）。
---

先读取 `AGENTS.md`、`WORKFLOW.md` 与 `.spec-kit.json`。

# 完整 Spec 规划与归档

## 1. 规划（Propose）
在隔离 worktree 的 `openspec/changes/<change-name>/` 下按需建立：
- `proposal.md`：背景、目标、明确不做（Non-goals）与影响范围
- `design.md`：架构边界、数据库/接口契约变化、并发/幂等/回滚策略
- `specs/<capability>/spec.md`：以 `ADDED` / `MODIFIED` / `REMOVED` 精确描述 Requirement 与 `WHEN / THEN` Scenario（`MODIFIED` 必须保留已有 Scenario 名称）
- `tasks.md`：按可验收结果与互斥写集组织的 `- [ ] X.Y 描述`

## 2. 实施（Apply）
- 严格在声明范围内实施；涉及数据库迁移须保证版本单调唯一，不改写已发布迁移。
- 每项经真实代码核对与精准测试验证后再勾选 `- [x]`。

## 3. 同步与归档（Archive）
- 全部任务完成后，将 `specs/` 合并到 `openspec/specs/<capability>/spec.md`（保留无关旧需求与既有 Scenario）。
- 将变更目录移动至 `openspec/changes/archive/YYYY-MM-DD-<change-name>/`（不随归档提交大型临时截图或导出文件）。
- 获授权提交后运行 `node scripts/spec-gates.mjs --json`。
