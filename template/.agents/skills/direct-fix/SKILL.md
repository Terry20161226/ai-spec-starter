---
name: direct-fix
description: 默认开发入口：处理明确缺陷、局部修复与既有模式内的普通功能，不创建额外 Spec 工件。
---

先读取仓库根目录 `AGENTS.md` 与 `WORKFLOW.md`。

# 直接开发（Direct Fix）

1. 通过 `bash scripts/create-worktree.sh "<fix|add|update>-<kebab-case>"` 创建或切入隔离 worktree（禁止直接改动主干分支）。
2. 先读相关实现与既有测试，确认真实契约与边界；影响若命中“库表迁移 / 跨服务契约 / 状态机重构 / 权限模型变更”，立即转为 `spec-full`。
3. 实施最小必要修改，并按受影响模块执行精准验证（如单测、typecheck 或格式检查）；缺失或未运行的验证如实汇报，绝不谎报通过。
4. 若改动长期公开契约，顺手更新 `openspec/specs/<capability>/spec.md`。
5. 获用户提交授权后提交（自动触发 `pre-commit` 静态红线门禁），并可运行 `node scripts/spec-gates.mjs --json` 验收；合并、远程推送与数据库写入需各自获得明确授权。
