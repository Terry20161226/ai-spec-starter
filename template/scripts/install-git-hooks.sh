#!/usr/bin/env bash
set -euo pipefail

# 将仓库受控 .githooks/ 接入当前 Git 公共 hooks 目录，兼容全局 core.hooksPath 转发与多 worktree。
QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

SCRIPT_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_REPO_ROOT" rev-parse --show-toplevel)"
COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)"
HOOKS_DIR="$COMMON_DIR/hooks"
mkdir -p "$HOOKS_DIR"

for HOOK in pre-commit pre-push; do
  chmod +x "$REPO_ROOT/.githooks/$HOOK"
  TARGET="$HOOKS_DIR/$HOOK"
  cat > "$TARGET" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ROOT="\$(git rev-parse --show-toplevel)"
if [[ -x "\$ROOT/.githooks/$HOOK" ]]; then
  exec "\$ROOT/.githooks/$HOOK" "\$@"
fi
EOF
  chmod +x "$TARGET"
done

if [[ "$QUIET" -eq 0 ]]; then
  echo "已安装本地 Git Hooks（pre-commit / pre-push）至：$HOOKS_DIR"
fi
