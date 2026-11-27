# AI Spec 2+1 分级研发工作流

本仓库采用轻量化 **“2+1 分级流程 + Git Hook 确定性卡口”**，平衡日常敏捷度与高危变更可控性。

## 流程选择

| 场景 | 选择模式 | 说明 |
| --- | --- | --- |
| 明确 Bug、局部修改、既有模式内的普通需求 | `direct-fix`（默认） | 查清事实 → 隔离修改 → 精准验证 → 提交，不建 change 工件 |
| 单域新功能，需要记录目标、契约与验收清单 | `spec-lite` | 在 `openspec/changes/<name>/contract.yaml` 记录目标、范围与任务 |
| 命中**数据库迁移 / 跨服务契约 / 状态机重构 / 权限模型**之一，或大型跨端协作 | `spec-full` | 创建 `proposal.md`、`design.md`、`specs/`、`tasks.md`，完成后同步至 `openspec/specs/` 并归档 |

## 标准操作

1. **创建隔离工作树**：
   ```bash
   bash scripts/create-worktree.sh "<type>-<kebab-case>"
   ```
   `<type>` 建议使用 `add` / `update` / `fix` / `refactor` / `remove`。
2. **实施与自检**：
   - 本地 `git commit` 自动触发 `.githooks/pre-commit`，对暂存区新增行执行 `.spec-kit.json` 静态红线检查与空白符检查。
   - 如需在提交后验收整体改动，运行：
     ```bash
     node scripts/spec-gates.mjs --json
     ```
3. **规格维护**：
   - 长期业务契约变更后同步更新 `openspec/specs/<capability>/spec.md`，已完成的 change 及时移入 `openspec/changes/archive/YYYY-MM-DD-<name>/`。
   - 更新 `.agents/` 下的 skills 或 commands 后执行 `bash .agents/update.sh` 并用 `--check` 复核。
