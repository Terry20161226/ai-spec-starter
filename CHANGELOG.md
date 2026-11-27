# Changelog

All notable changes to `ai-spec-starter` are documented in this file.

## [0.2.3] - 2026-11-27

### Added
- `CHANGELOG.md` 与 `.github/workflows/release.yml`：推送 `v*` tag 时先运行跨平台全量测试，再自动创建 GitHub Release。
- `spec-gates.test.mjs` 新增旧版精简 `.spec-kit.json`（省略 `paths` / `disableGuardrails` / `customGuardrails`）向后兼容测试。
- `ci.yml` 与 `starter.test.mjs` 新增仓库自身 Bash 语法（`bash -n`）与密钥基线自举校验（Dogfooding）。

## [0.2.2] - 2026-11-27

### Added
- `.github/workflows/ci.yml` 与 MIT `LICENSE`：在 `ubuntu-latest` 与 `macos-latest`（Node 22）跑通全量测试。
- `G-SEC-PRIVATE-KEY` 明文私钥拦截测试用例。

### Fixed
- `scripts/create-worktree.sh`：基于 `--git-common-dir` 解析主仓目录，修复在已有 linked worktree 内再建工作树导致 `-wt-...-wt-...` 嵌套问题。
- `scripts/spec-gates.mjs`：修复带 `## Purpose` 的 delta spec 在 `## ADDED/MODIFIED Requirements` 章节漏检占位符问题；为 `--root` / `--target` / `--branch` / `--presets` 补齐缺参 Fail-Closed 校验；结构化拦截非法 `customGuardrails` 正则。

## [0.2.1] - 2026-11-27

### Fixed
- `G-TS-NO-FLOAT-MONEY`：支持识别 TypeScript 带类型标注的左值赋值（如 `const fee: number = Number(raw)`）。
- `G-AGENT-MIRROR-DRIFT`：`--staged` 模式补充检出“已运行 `update.sh` 同步镜像但忘记 `git add .claude .qoder .codex`”场景。
- `G-SQL-DUPLICATE-VERSION`：将版本查重基准收口到迁移根目录，覆盖子目录版本冲突。
- `.githooks/pre-push`：兼容 `.spec-kit.json#project.worktreeRequired = false` 的单树开发仓库；验证 0 提交空仓库（unborn `HEAD`）初始化与首提交。

## [0.2.0] - 2026-11-27

### Added
- 补齐 `sql-flyway` 真实护栏：`G-SQL-IMMUTABLE-MIGRATION`（禁止修改/删除已提交迁移）与 `G-SQL-DUPLICATE-VERSION`。
- 新增 `G-AGENT-MIRROR-DRIFT`、`G-PY-UNSAFE-YAML`、`G-SPEC-HYGIENE` 与 `.agents/.starter-version` 可追溯升级机制。
- `init.sh` 支持自动探测 `migrations/` / `db/migration/` 并开启 `sql-flyway`。
