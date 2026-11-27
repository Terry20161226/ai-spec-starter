#!/usr/bin/env bash
set -euo pipefail

# 创建隔离 Git worktree 并同步安装本地 Git Hooks；分支默认读取 .spec-kit.json#project.targetBranch。
# 用法：bash scripts/create-worktree.sh <change-name> [base-branch] [--setup]

CHANGE_NAME="${1:-}"
if [[ -z "$CHANGE_NAME" ]]; then
  echo "用法: $0 <change-name> [base-branch] [--setup]" >&2
  exit 2
fi
shift || true

BASE_BRANCH=""
RUN_SETUP=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --setup) RUN_SETUP=1; shift ;;
    *)
      if [[ -z "$BASE_BRANCH" ]]; then BASE_BRANCH="$1"; shift; else echo "未知参数: $1" >&2; exit 2; fi
      ;;
  esac
done

if [[ ! "$CHANGE_NAME" =~ ^(add|update|fix|remove|refactor|migrate)-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "错误: change 名不合法（需 <verb>-<kebab-case>）：$CHANGE_NAME" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_BRANCH="main"
SETUP_CMD=""
if [[ -f "$REPO_ROOT/.spec-kit.json" ]]; then
  DEFAULT_BRANCH="$(node -e '
    const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(cfg?.project?.targetBranch || "main");
  ' "$REPO_ROOT/.spec-kit.json")"
  SETUP_CMD="$(node -e '
    const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(cfg?.project?.worktreeSetupCommand || "");
  ' "$REPO_ROOT/.spec-kit.json")"
fi

BASE_BRANCH="${BASE_BRANCH:-$DEFAULT_BRANCH}"
BRANCH_NAME="spec/${CHANGE_NAME}"
COMMON_ROOT="$(dirname "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)")"
REPO_BASE="$(basename "$COMMON_ROOT")"
PARENT_DIR="$(dirname "$COMMON_ROOT")"
WORKTREE_PATH="${PARENT_DIR}/${REPO_BASE}-wt-${CHANGE_NAME}"

if [[ -e "$WORKTREE_PATH" ]]; then
  echo "工作树目录已存在：$WORKTREE_PATH" >&2
  exit 1
fi

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
  git -C "$REPO_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

if [[ -x "$WORKTREE_PATH/scripts/install-git-hooks.sh" ]]; then
  bash "$WORKTREE_PATH/scripts/install-git-hooks.sh" --quiet || true
fi

if [[ "$RUN_SETUP" -eq 1 ]] && [[ -n "$SETUP_CMD" ]]; then
  (cd "$WORKTREE_PATH" && bash -c "$SETUP_CMD")
fi

echo "WORKTREE_PATH=$WORKTREE_PATH"
