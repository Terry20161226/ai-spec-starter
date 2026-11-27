#!/usr/bin/env bash
# 将 .agents（SSOT）中的 skills、commands 与可选 hooks 同步到各 AI IDE 镜像目录；
# Codex 直接原生发现 .agents/skills，其余镜像通过内容校验同步。
#
# 用法：
#   bash .agents/update.sh           # 同步镜像
#   bash .agents/update.sh --dry-run # 只报告差异，不写文件
#   bash .agents/update.sh --check   # 只读检查；存在缺失、漂移或过期文件时非零退出

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILLS_SRC="${REPO_ROOT}/.agents/skills"
COMMANDS_SRC="${REPO_ROOT}/.agents/commands"
HOOKS_SRC="${REPO_ROOT}/.agents/hooks"
MODE="sync"

usage() {
  echo "Usage: bash .agents/update.sh [--dry-run|--check]" >&2
}

if [[ "$#" -gt 1 ]]; then
  usage
  exit 2
fi
if [[ "$#" -eq 1 ]]; then
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --check) MODE="check" ;;
    *) usage; exit 2 ;;
  esac
fi

assert_safe_root() {
  local label="$1"
  local path="$2"
  local component="${path}"
  while [[ "${component}" != "${REPO_ROOT}" ]]; do
    if [[ -L "${component}" ]]; then
      echo "${label} path must not contain a symlink: ${component}" >&2
      exit 1
    fi
    if [[ -e "${component}" && ! -d "${component}" ]]; then
      echo "${label} path component must be a directory: ${component}" >&2
      exit 1
    fi
    component="$(dirname "${component}")"
  done
  if [[ -L "${path}" ]]; then
    echo "${label} must not be a symlink: ${path}" >&2
    exit 1
  fi
  if [[ -e "${path}" && ! -d "${path}" ]]; then
    echo "${label} must be a directory when present: ${path}" >&2
    exit 1
  fi
}

assert_safe_tree() {
  local label="$1"
  local path="$2"
  local link=""
  assert_safe_root "${label}" "${path}"
  if [[ -e "${path}" ]]; then
    link="$(find "${path}" -type l -print -quit)"
    if [[ -n "${link}" ]]; then
      echo "${label} contains a symlink: ${link}" >&2
      exit 1
    fi
  fi
}

for source in "${SKILLS_SRC}" "${COMMANDS_SRC}"; do
  if [[ ! -d "${source}" || -L "${source}" ]]; then
    echo "Required SSOT source directory is missing or unsafe: ${source}" >&2
    exit 1
  fi
  assert_safe_tree "SSOT source" "${source}"
done

HOOKS_ENABLED=0
if [[ -d "${HOOKS_SRC}" && ! -L "${HOOKS_SRC}" ]]; then
  assert_safe_tree "SSOT source" "${HOOKS_SRC}"
  HOOKS_ENABLED=1
fi

SKILL_TARGETS=(
  "${REPO_ROOT}/.claude/skills"
  "${REPO_ROOT}/.qoder/skills"
)
COMMAND_TARGETS=(
  "${REPO_ROOT}/.claude/commands"
  "${REPO_ROOT}/.qoder/commands"
  "${REPO_ROOT}/.codex/commands"
)
HOOK_TARGETS=(
  "${REPO_ROOT}/.claude/hooks"
  "${REPO_ROOT}/.qoder/hooks"
  "${REPO_ROOT}/.codex/hooks"
)

for tool_root in "${REPO_ROOT}/.claude" "${REPO_ROOT}/.qoder" "${REPO_ROOT}/.codex"; do
  assert_safe_root "Tool mirror root" "${tool_root}"
done
for target in "${SKILL_TARGETS[@]}" "${COMMAND_TARGETS[@]}" "${HOOK_TARGETS[@]}"; do
  assert_safe_tree "Tool mirror target" "${target}"
done

drift=0

compare_tree() {
  local label="$1"
  local source="$2"
  local target="$3"
  local output=""
  if [[ ! -d "${target}" ]]; then
    echo "missing mirror: ${label}"
    drift=1
    return
  fi
  output="$(rsync -ainc --delete "${source}/" "${target}/" | grep -Ev '^\.[fd]\.\.[tT]\.+ ' || true)"
  if [[ -n "${output}" ]]; then
    echo "mirror drift/stale: ${label}"
    echo "${output}"
    drift=1
  fi
}

if [[ "${MODE}" == "check" || "${MODE}" == "dry-run" ]]; then
  for target in "${SKILL_TARGETS[@]}"; do
    compare_tree "skills -> ${target}" "${SKILLS_SRC}" "${target}"
  done
  for target in "${COMMAND_TARGETS[@]}"; do
    compare_tree "commands -> ${target}" "${COMMANDS_SRC}" "${target}"
  done
  if [[ "${HOOKS_ENABLED}" -eq 1 ]]; then
    for target in "${HOOK_TARGETS[@]}"; do
      compare_tree "hooks -> ${target}" "${HOOKS_SRC}" "${target}"
    done
  fi
  if [[ "${MODE}" == "dry-run" ]]; then
    echo "[dry-run] no files were written"
    exit 0
  fi
  if [[ "${drift}" -ne 0 ]]; then
    echo "Agent mirror check failed: missing, drifted, or stale files found." >&2
    exit 1
  fi
  echo "Agent mirrors are current."
  exit 0
fi

for target in "${SKILL_TARGETS[@]}"; do
  mkdir -p "${target}"
  rsync -ac --delete "${SKILLS_SRC}/" "${target}/"
  echo "skills -> ${target}"
done
for target in "${COMMAND_TARGETS[@]}"; do
  mkdir -p "${target}"
  rsync -ac --delete "${COMMANDS_SRC}/" "${target}/"
  echo "commands -> ${target}"
done
if [[ "${HOOKS_ENABLED}" -eq 1 ]]; then
  for target in "${HOOK_TARGETS[@]}"; do
    mkdir -p "${target}"
    rsync -ac --delete "${HOOKS_SRC}/" "${target}/"
    echo "hooks -> ${target}"
  done
fi

echo "Done."
