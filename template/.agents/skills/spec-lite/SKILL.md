---
name: spec-lite
description: 单域常规功能的轻量化规格规划：只维护单文件 contract.yaml 与简洁 specs/tasks，不过度拆件。
---

先读取 `AGENTS.md` 与 `WORKFLOW.md`。仅单域明确功能需要沉淀契约与验收时使用。

# 轻量规格（Spec Lite）

1. 在隔离 worktree 下创建 `openspec/changes/<change-name>/contract.yaml`，只记录：
   - `goal`：业务目标与验收标准（When/Then）
   - `currentFacts`：核实过的当前源码/配置/数据结构边界
   - `solution`：拟改路径与关键设计取舍
   - `tasks`：可独立验收的最小任务清单
2. 仅当需要修改长期系统规格时补充 `openspec/changes/<change-name>/specs/<capability>/spec.md`。
3. 实施并完成验证后，将有变更的 spec 同步到 `openspec/specs/`，并将目录移入 `openspec/changes/archive/YYYY-MM-DD-<change-name>/`。
