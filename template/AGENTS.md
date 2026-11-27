# AGENTS.md — __PROJECT_NAME__ Agent 工程规范

核心约束见 [工作流说明](WORKFLOW.md) 与 [门禁配置](.spec-kit.json)。

## 工作边界

- **先查事实再动手**：修改前先检索真实调用链、配置、Schema 与既有测试；关键需求或范围不明时先提问澄清。
- **默认直接开发**：明确 Bug、局部修复、既有模式内功能走 `direct-fix`，不额外制造 Spec 文档；仅命中四类高危信号（库表迁移、跨服务契约、状态机重构、权限模型变更）时走 `spec-full`。
- **隔离沙箱修改**：在 `scripts/create-worktree.sh <change-name>` 创建的隔离 worktree 中修改，禁止直接在 `__TARGET_BRANCH__` 主干编辑。
- **授权边界**：Git 提交、分支合并、远程推送、真实生产/共享数据库写入、发布部署均需明确用户授权。
- **测试原则**：只为受影响边界做精准验证；不虚构未执行的测试通过结果；已发布数据库迁移不得原地改写。

## 技术栈与目录约定

<!-- 在这里补充本项目的模块划分、运行命令、格式化命令与领域特定红线 -->
- 主干分支：`__TARGET_BRANCH__`
- 启用门禁预设：见 `.spec-kit.json#presets`
- 项目专属技能放置于：`.agents/skills/<domain>-patterns/SKILL.md`（修改后运行 `bash .agents/update.sh` 同步至多 IDE）
