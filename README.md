# ai-spec-starter

[![CI](https://github.com/Terry20161226/ai-spec-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/Terry20161226/ai-spec-starter/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

轻量、零外部依赖、多技术栈通用的 **AI Spec 驱动开发与确定性门禁** 骨架模板（从实战工程中剥离业务耦合提炼而成）。

## 包含什么

- **2+1 分级研发流（`WORKFLOW.md` + `.agents/skills/`）**：
  - `direct-fix`：默认入口，普通修复、展示调整与既有模式内功能直接做，不强行建文档。
  - `spec-lite`：单文件 `contract.yaml` 轻量规划，用于单域中等复杂度功能。
  - `spec-full`：仅命中结构迁移、跨服务契约、状态机重构、权限模型 4 类高危边界时走完整 Spec 与活文档归档。
- **多 IDE 规范单一真源（`.agents/` + `update.sh`）**：只在 `.agents/` 维护一份 skills 与 commands，自动同步至 `.claude/`、`.qoder/`、`.codex/`，支持内容级 `--check`（已免疫 git mtime 误报）。
- **隔离沙箱与本地 Git Hooks（`scripts/create-worktree.sh` + `.githooks/`）**：强制隔离 Worktree 开发，提交前触发 `pre-commit`（`--staged` 增量秒级拦截），推送前触发 `pre-push`（分支、clean、committed diff）。
- **零依赖配置化静态门禁（`scripts/spec-gates.mjs` + `.spec-kit.json`）**：纯 Node.js 标准库实现，内置 5 个技术栈预设（Java Jakarta / TS 浮点精度与赋值红线 / SQL Flyway 冲突与不可变迁移守卫 / Python 安全与 `yaml.load` 检查 / 私钥防泄漏）、`.agents/` 镜像防漂移守卫、Spec 占位符守卫与 `customGuardrails`。
- **可追溯升级（`.agents/.starter-version`）**：重复执行 `init.sh` 只刷新框架内核与版本号（如 `0.2.1 -> 0.2.2`），不覆盖项目自定义配置与业务规格。

## 快速初始化到任意项目

```bash
# 在当前模板仓库根目录执行，指定目标业务项目路径：
bash ./init.sh /path/to/your-project

# 或显式指定主干分支与预设：
bash ./init.sh /path/to/your-project \
  --branch main \
  --presets java-jakarta,ts-no-float-money,sql-flyway,secrets-baseline
```

初始化后可直接在目标项目运行：

```bash
# 创建隔离开发 worktree
bash scripts/create-worktree.sh add-example-feature

# 检查多 IDE 规范镜像
bash .agents/update.sh --check

# 检查已提交变更是否符合门禁（传 --staged 检查暂存区）
node scripts/spec-gates.mjs --json
```

## 运行模板自检测试

```bash
node --test tests/starter.test.mjs template/scripts/spec-gates.test.mjs
```
