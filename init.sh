#!/usr/bin/env bash
set -euo pipefail

# 将 ai-spec-starter 最小治理内核注入任意 Git 仓库。
# 用法：bash init.sh <target-repo-dir> [--branch main|develop] [--presets p1,p2] [--force]

STARTER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$STARTER_ROOT/template"

TARGET_DIR=""
BRANCH_ARG=""
PRESETS_ARG=""
FORCE=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ "$#" -ge 2 && -n "${2:-}" && "${2:-}" != --* ]] || { echo "--branch 缺少参数值" >&2; exit 2; }
      BRANCH_ARG="$2"; shift 2
      ;;
    --presets)
      [[ "$#" -ge 2 && -n "${2:-}" && "${2:-}" != --* ]] || { echo "--presets 缺少参数值" >&2; exit 2; }
      PRESETS_ARG="$2"; shift 2
      ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "用法: bash init.sh <target-repo> [--branch main|develop] [--presets java-jakarta,ts-no-float-money,sql-flyway,python-safety,secrets-baseline] [--force]"
      exit 0
      ;;
    *)
      if [[ -z "$TARGET_DIR" ]]; then TARGET_DIR="$1"; shift; else echo "未知参数: $1" >&2; exit 2; fi
      ;;
  esac
done

if [[ -z "$TARGET_DIR" ]] || [[ ! -d "$TARGET_DIR" ]]; then
  echo "请提供有效的目标 Git 仓库目录" >&2
  exit 2
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
if ! git -C "$TARGET_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "目标目录不是 Git 仓库：$TARGET_DIR" >&2
  exit 2
fi

PROJECT_NAME="$(basename "$TARGET_DIR")"

# 自动探测主干分支（--branch 优先，否则按当前分支或常见主干推断）。
if [[ -n "$BRANCH_ARG" ]]; then
  TARGET_BRANCH="$BRANCH_ARG"
elif git -C "$TARGET_DIR" show-ref --verify --quiet refs/heads/develop; then
  TARGET_BRANCH="develop"
elif git -C "$TARGET_DIR" show-ref --verify --quiet refs/heads/main; then
  TARGET_BRANCH="main"
elif git -C "$TARGET_DIR" show-ref --verify --quiet refs/heads/master; then
  TARGET_BRANCH="master"
else
  TARGET_BRANCH="$(git -C "$TARGET_DIR" symbolic-ref --quiet --short HEAD || echo "main")"
fi

# 按目标仓文件特征自动推荐预设，始终启用 secrets-baseline。
if [[ -n "$PRESETS_ARG" ]]; then
  PRESETS_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1].split(",").map(s=>s.trim()).filter(Boolean)))' "$PRESETS_ARG")"
else
  PRESETS_JSON="$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.argv[1];
    const presets = new Set(["secrets-baseline"]);
    if (fs.existsSync(path.join(dir, "pom.xml")) || fs.existsSync(path.join(dir, "build.gradle")) || fs.existsSync(path.join(dir, "build.gradle.kts"))) {
      presets.add("java-jakarta");
      presets.add("sql-flyway");
    }
    if (fs.existsSync(path.join(dir, "migrations")) || fs.existsSync(path.join(dir, "db/migration"))) {
      presets.add("sql-flyway");
    }
    if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      presets.add("ts-no-float-money");
    }
    if (fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "requirements.txt")) || fs.existsSync(path.join(dir, "setup.py"))) {
      presets.add("python-safety");
    }
    process.stdout.write(JSON.stringify([...presets]));
  ' "$TARGET_DIR")"
fi

copy_engine_file() {
  local rel="$1"
  mkdir -p "$TARGET_DIR/$(dirname "$rel")"
  cp "$TEMPLATE_DIR/$rel" "$TARGET_DIR/$rel"
}

copy_project_file_if_missing() {
  local rel="$1"
  local dest="$TARGET_DIR/$rel"
  if [[ -f "$dest" ]] && [[ "$FORCE" -ne 1 ]]; then
    echo "保留已有项目文件：$rel"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  node -e '
    const fs = require("node:fs");
    let content = fs.readFileSync(process.argv[1], "utf8");
    content = content
      .replaceAll("__PROJECT_NAME__", process.argv[3])
      .replaceAll("__TARGET_BRANCH__", process.argv[4])
      .replaceAll("__PRESETS_JSON__", process.argv[5]);
    fs.writeFileSync(process.argv[2], content);
  ' "$TEMPLATE_DIR/$rel" "$dest" "$PROJECT_NAME" "$TARGET_BRANCH" "$PRESETS_JSON"
  echo "生成项目配置：$rel"
}

# 1. 引擎文件（可幂等覆盖升级，不触及项目自定义域技能与 specs）
ENGINE_FILES=(
  ".agents/.starter-version"
  ".agents/update.sh"
  ".agents/skills/direct-fix/SKILL.md"
  ".agents/skills/spec-lite/SKILL.md"
  ".agents/skills/spec-full/SKILL.md"
  ".agents/commands/direct-fix.md"
  ".agents/commands/spec/propose.md"
  ".agents/commands/spec/apply.md"
  ".agents/commands/spec/archive.md"
  ".githooks/pre-commit"
  ".githooks/pre-push"
  "scripts/spec-gates.mjs"
  "scripts/spec-gates.test.mjs"
  "scripts/create-worktree.sh"
  "scripts/install-git-hooks.sh"
  "WORKFLOW.md"
)

STARTER_VER="$(tr -d '[:space:]' < "$TEMPLATE_DIR/.agents/.starter-version")"
PREV_VER="none"
if [[ -f "$TARGET_DIR/.agents/.starter-version" ]]; then
  PREV_VER="$(tr -d '[:space:]' < "$TARGET_DIR/.agents/.starter-version")"
fi

for rel in "${ENGINE_FILES[@]}"; do
  copy_engine_file "$rel"
done

chmod +x \
  "$TARGET_DIR/.githooks/pre-commit" \
  "$TARGET_DIR/.githooks/pre-push" \
  "$TARGET_DIR/scripts/create-worktree.sh" \
  "$TARGET_DIR/scripts/install-git-hooks.sh"

# 2. 项目所属配置（存在则跳过，避免升级冲掉业务自定义）
copy_project_file_if_missing ".spec-kit.json"
copy_project_file_if_missing "AGENTS.md"

for keep in "openspec/changes/.gitkeep" "openspec/changes/archive/.gitkeep" "openspec/specs/.gitkeep"; do
  if [[ ! -f "$TARGET_DIR/$keep" ]]; then
    copy_engine_file "$keep"
  fi
done

# 3. 同步多 IDE 镜像并安装本地 Git Hooks
bash "$TARGET_DIR/.agents/update.sh"
bash "$TARGET_DIR/scripts/install-git-hooks.sh"

echo "完成：$TARGET_DIR (version=$PREV_VER -> $STARTER_VER, targetBranch=$TARGET_BRANCH, presets=$PRESETS_JSON)"
