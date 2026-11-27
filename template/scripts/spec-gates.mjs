#!/usr/bin/env node
/**
 * 轻量可配置静态交付门禁 v0.2.2（零外部 npm 依赖）。
 * 读取仓库根目录 .spec-kit.json：
 *   - project.targetBranch / project.worktreeRequired
 *   - presets: java-jakarta | ts-no-float-money | sql-flyway | python-safety | secrets-baseline
 *   - disableGuardrails / customGuardrails
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = '/usr/bin/git';
const FULL_COMMIT = /^[0-9a-f]{40}$/;

const DEFAULT_CONFIG = {
  project: { name: 'project', targetBranch: 'main', worktreeRequired: true },
  presets: ['secrets-baseline'],
  paths: {
    migrationRegex: '(?:^|/)(?:db/migration|migrations|alembic/versions)/|(?:^|/)V\\d+(?:[._]\\d+)*__[^/]+\\.sql$',
    javaSourceRegex: '\\.java$',
    tsSourceRegex: '\\.(?:ts|tsx|js|jsx)$',
    pythonSourceRegex: '\\.py$',
    ignoreTestRegex: '(?:^|/)(?:tests?|__tests__|mock-server)/|\\.(?:test|spec)\\.[tj]sx?$|_test\\.py$',
  },
  disableGuardrails: [],
  customGuardrails: [],
};

class GateError extends Error {
  constructor(failureClass, message) {
    super(message);
    this.failureClass = failureClass;
  }
}

function fail(failureClass, message) {
  throw new GateError(failureClass, message);
}

function gitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !k.startsWith('GIT_') && typeof v === 'string')),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function runGit(root, args, { allowFailure = false } = {}) {
  const child = spawnSync(GIT, args, {
    cwd: root,
    env: gitEnv(),
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.error || (!allowFailure && child.status !== 0)) {
    fail('INSUFFICIENT_EVIDENCE', `Git 事实不可读：${args.join(' ')}`);
  }
  return child;
}

function gitText(root, args) {
  return runGit(root, args).stdout.toString('utf8').trim();
}

export function loadSpecKitConfig(root) {
  const configPath = join(root, '.spec-kit.json');
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail('INSUFFICIENT_EVIDENCE', `.spec-kit.json 解析失败：${error.message}`);
  }
  return {
    project: { ...DEFAULT_CONFIG.project, ...(parsed.project ?? {}) },
    presets: Array.isArray(parsed.presets) ? parsed.presets : DEFAULT_CONFIG.presets,
    paths: { ...DEFAULT_CONFIG.paths, ...(parsed.paths ?? {}) },
    disableGuardrails: Array.isArray(parsed.disableGuardrails) ? parsed.disableGuardrails : [],
    customGuardrails: Array.isArray(parsed.customGuardrails) ? parsed.customGuardrails : [],
  };
}

/** 解析 name-status -z 输出，返回去重排序路径及 statusMap（A/M/D/R/C）。 */
export function parseChangedEntries(buffer) {
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < records.length;) {
    const status = records[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = records[i++];
      const newPath = records[i++];
      if (oldPath) entries.push({ status: 'D', path: oldPath });
      if (newPath) entries.push({ status: 'A', path: newPath });
    } else {
      const p = records[i++];
      if (p) entries.push({ status: code, path: p });
    }
  }
  const byPath = new Map();
  for (const item of entries) byPath.set(item.path, item.status);
  return {
    paths: [...byPath.keys()].sort(),
    statusByPath: byPath,
  };
}

export function parseChangedPaths(buffer) {
  return parseChangedEntries(buffer).paths;
}

function addedLines(root, diffArgs) {
  const child = runGit(root, diffArgs, { allowFailure: true });
  if (child.status !== 0) return [];
  return child.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++ '));
}

function isComment(line, filePath) {
  const body = line.slice(1).trim();
  if (/\.py$/i.test(filePath)) return body.startsWith('#');
  return body.startsWith('//') || body.startsWith('/*') || body.startsWith('*') || body.startsWith('--');
}

function parseFlywayVersion(fileName) {
  const match = /^V(\d+(?:[._]\d+)*)__.+\.sql$/i.exec(fileName);
  if (!match) return null;
  const parts = match[1].split(/[._]/).map((n) => Number.parseInt(n, 10));
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

function collectSqlFilesInDir(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...collectSqlFilesInDir(abs, rel));
    else if (/\.sql$/i.test(entry.name)) results.push(rel);
  }
  return results;
}

function resolveMigrationRoot(root, relPath) {
  const match = /^(.*?\/(?:db\/migration|migrations|alembic\/versions))\/.+$/i.exec(relPath)
    || /^((?:db\/migration|migrations|alembic\/versions))\/.+$/i.exec(relPath);
  if (match) return join(root, match[1]);
  return dirname(join(root, relPath));
}

function inspectFlywayMigrations({ root, config, changedPaths, statusByPath, disabled, findings }) {
  if (!new Set(config.presets ?? []).has('sql-flyway')) return;
  const migRe = new RegExp(config.paths.migrationRegex, 'i');
  const touchedMigrations = changedPaths.filter((p) => migRe.test(p) && /\.sql$/i.test(p));
  if (touchedMigrations.length === 0) return;

  if (!disabled.has('G-SQL-IMMUTABLE-MIGRATION')) {
    for (const p of touchedMigrations) {
      const st = statusByPath.get(p);
      if (st && st !== 'A') {
        findings.push({
          rule: 'G-SQL-IMMUTABLE-MIGRATION',
          path: p,
          message: `禁止修改或删除已有数据库迁移（status=${st}），请新增递增版本 migration 文件`,
        });
      }
    }
  }

  if (root && !disabled.has('G-SQL-DUPLICATE-VERSION')) {
    // 按各自迁移根目录分组递归检查版本唯一性（覆盖 migrations/ 下子目录冲突）
    const checkedRoots = new Set();
    for (const p of touchedMigrations) {
      const dir = resolveMigrationRoot(root, p);
      if (checkedRoots.has(dir)) continue;
      checkedRoots.add(dir);
      const versions = new Map();
      for (const file of collectSqlFilesInDir(dir)) {
        const ver = parseFlywayVersion(basename(file));
        if (!ver) continue;
        if (versions.has(ver)) {
          findings.push({
            rule: 'G-SQL-DUPLICATE-VERSION',
            path: p,
            message: `Flyway 迁移版本冲突（v${ver}）：${versions.get(ver)} 与 ${file}`,
          });
        } else {
          versions.set(ver, file);
        }
      }
    }
  }
}

function inspectAgentMirrors({ root, changedPaths, disabled, findings, staged = false }) {
  if (!root || disabled.has('G-AGENT-MIRROR-DRIFT')) return;
  const touchedAgentFile = changedPaths.some((p) => /^\.(?:agents|claude|qoder|codex)\//.test(p));
  if (!touchedAgentFile) return;
  const updater = join(root, '.agents', 'update.sh');
  if (!existsSync(updater)) return;
  const check = spawnSync('bash', [updater, '--check'], { cwd: root, encoding: 'utf8' });
  if (check.status !== 0) {
    findings.push({
      rule: 'G-AGENT-MIRROR-DRIFT',
      path: '.agents/',
      message: '修改了 .agents/ 或 IDE 镜像但未同步，请先运行 bash .agents/update.sh',
    });
    return;
  }
  if (staged) {
    const unstagedMirrors = gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', '.claude', '.qoder', '.codex'])
      .split('\n')
      .filter((line) => line.length >= 2 && (line[0] === '?' || (line[1] !== ' ' && line[1] !== '')));
    if (unstagedMirrors.length > 0) {
      findings.push({
        rule: 'G-AGENT-MIRROR-DRIFT',
        path: '.agents/',
        message: '已生成 IDE 镜像但未加入暂存区，请 git add .claude .qoder .codex 后再提交',
      });
    }
  }
}

function inspectSpecHygiene({ root, changedPaths, statusByPath, disabled, findings }) {
  if (!root || disabled.has('G-SPEC-HYGIENE')) return;
  const activeSpecs = changedPaths.filter((p) =>
    /^openspec\/(?:specs\/.+|changes\/(?!archive\/)[^/]+\/specs\/.+)\/spec\.md$/.test(p) && statusByPath.get(p) !== 'D');
  for (const p of activeSpecs) {
    const abs = join(root, p);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (!/^### Requirement:/m.test(text) || !/^#### Scenario:/m.test(text)) {
      findings.push({
        rule: 'G-SPEC-HYGIENE',
        path: p,
        message: 'Spec 文档必须至少包含一个 ### Requirement: 与一个 #### Scenario:',
      });
    } else if (/^\s*(?:TBD|TODO|待定|待补)\s*$/mi.test(
      text.replace(/^## Purpose[\s\S]*?(?=^## (?:(?:ADDED|MODIFIED|REMOVED|RENAMED)\s+)?Requirements|(?![\s\S]))/m, ''),
    )) {
      findings.push({
        rule: 'G-SPEC-HYGIENE',
        path: p,
        message: 'Spec Requirements 中禁止保留未决占位符（TBD/TODO/待定/待补）',
      });
    }
  }
}

function compileRules(config) {
  const disabled = new Set(config.disableGuardrails ?? []);
  const presets = new Set(config.presets ?? []);
  const javaRe = new RegExp(config.paths.javaSourceRegex);
  const tsRe = new RegExp(config.paths.tsSourceRegex);
  const pyRe = new RegExp(config.paths.pythonSourceRegex);
  const migRe = new RegExp(config.paths.migrationRegex, 'i');
  const ignoreTestRe = config.paths.ignoreTestRegex ? new RegExp(config.paths.ignoreTestRegex) : null;
  const rules = [];

  if (presets.has('secrets-baseline')) {
    rules.push({
      id: 'G-SEC-PRIVATE-KEY',
      matchFile: () => true,
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
      severity: 'error',
      ignoreComments: false,
      message: '禁止将私钥明文写入仓库',
    });
  }
  if (presets.has('java-jakarta')) {
    rules.push({
      id: 'G-JAVA-JAKARTA',
      matchFile: (p) => javaRe.test(p),
      pattern: /^\+\s*import\s+javax\.(?:persistence|servlet|validation|annotation|inject|ws\.rs|transaction)\b/,
      severity: 'error',
      ignoreComments: true,
      message: '禁止新增 javax.* Jakarta EE 依赖，请使用 jakarta.*',
    });
  }
  if (presets.has('ts-no-float-money')) {
    const moneyTokens = '(?:amount|money|price|fee|cost|total|qty|quantity|count|weight|volume|tax|rate)';
    rules.push({
      id: 'G-TS-NO-FLOAT-MONEY',
      matchFile: (p) => tsRe.test(p) && !(ignoreTestRe && ignoreTestRe.test(p)),
      pattern: new RegExp(
        `(?:\\b(?:Number|parseFloat)\\s*\\([^)]*${moneyTokens}\\b|\\b[a-zA-Z0-9_$]*${moneyTokens}[a-zA-Z0-9_$]*(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:Number|parseFloat)\\s*\\()`,
        'i',
      ),
      severity: 'error',
      ignoreComments: true,
      message: '数量/金额禁止使用 Number()/parseFloat() 二进制浮点运算，请使用十进制字符串或定点计算',
    });
  }
  if (presets.has('python-safety')) {
    rules.push({
      id: 'G-PY-BARE-EXCEPT',
      matchFile: (p) => pyRe.test(p) && !(ignoreTestRe && ignoreTestRe.test(p)),
      pattern: /^\+\s*except\s*:/,
      severity: 'error',
      ignoreComments: true,
      message: '禁止使用裸 except:（会吞掉 SystemExit/KeyboardInterrupt），请捕获明确异常类型',
    });
    rules.push({
      id: 'G-PY-HARDCODED-SECRET',
      matchFile: (p) => pyRe.test(p) && !(ignoreTestRe && ignoreTestRe.test(p)),
      pattern: /\b(?:api_key|secret_key|password|access_token)\s*=\s*['"][^'"]{8,}['"]/i,
      severity: 'error',
      ignoreComments: true,
      message: '禁止在 Python 源码中硬编码密钥或口令，请改为环境变量读取',
    });
    rules.push({
      id: 'G-PY-UNSAFE-YAML',
      matchFile: (p) => pyRe.test(p) && !(ignoreTestRe && ignoreTestRe.test(p)),
      pattern: /\byaml\.load\s*\((?![^)]*SafeLoader)/,
      severity: 'error',
      ignoreComments: true,
      message: '禁止无 SafeLoader 调用 yaml.load()，请使用 yaml.safe_load()',
    });
  }
  if (presets.has('sql-flyway')) {
    rules.push({
      id: 'G-SQL-TABLE-SYSTEM-COLS',
      matchFile: (p) => migRe.test(p) && /\.sql$/i.test(p),
      type: 'sql-block',
      severity: 'warning',
      message: '新增 CREATE TABLE 缺少 is_deleted 或 created_at 审计字段，请确认建表规范',
    });
  }

  for (const custom of config.customGuardrails ?? []) {
    if (!custom?.id || !custom?.pattern) continue;
    try {
      const fileRe = custom.files ? new RegExp(custom.files) : null;
      const patternRe = new RegExp(custom.pattern, custom.flags ?? '');
      rules.push({
        id: String(custom.id),
        matchFile: (p) => (fileRe ? fileRe.test(p) : true) && !(custom.ignoreTests !== false && ignoreTestRe?.test(p)),
        pattern: patternRe,
        severity: custom.severity === 'warning' ? 'warning' : 'error',
        ignoreComments: custom.ignoreComments !== false,
        message: String(custom.message ?? `命中自定义红线 ${custom.id}`),
      });
    } catch (error) {
      fail('INSUFFICIENT_EVIDENCE', `customGuardrails[${custom.id}] 正则非法：${error.message}`);
    }
  }

  return rules.filter((r) => !disabled.has(r.id));
}

export function inspectGuardrails(config, changedPaths, getAddedLines, { root = null, statusByPath = new Map(), checkMirrors = false, staged = false } = {}) {
  const disabled = new Set(config.disableGuardrails ?? []);
  const rules = compileRules(config);
  const findings = [];
  const warnings = [];
  let checkedFiles = 0;

  for (const filePath of changedPaths) {
    const matchingRules = rules.filter((r) => r.matchFile(filePath));
    if (matchingRules.length === 0) continue;
    checkedFiles += 1;
    const lines = getAddedLines(filePath);
    if (lines.length === 0) continue;

    for (const rule of matchingRules) {
      if (rule.type === 'sql-block') {
        const sql = lines.map((l) => l.slice(1)).join('\n');
        if (/\bCREATE\s+TABLE\b/i.test(sql) && (!/\bis_deleted\b/i.test(sql) || !/\bcreated_at\b/i.test(sql))) {
          warnings.push({ rule: rule.id, path: filePath, message: rule.message });
        }
        continue;
      }
      for (const line of lines) {
        if (rule.ignoreComments && isComment(line, filePath)) continue;
        if (rule.pattern.test(line)) {
          const item = { rule: rule.id, path: filePath, message: rule.message };
          if (rule.severity === 'warning') warnings.push(item);
          else findings.push(item);
        }
      }
    }
  }

  inspectFlywayMigrations({ root, config, changedPaths, statusByPath, disabled, findings });
  inspectSpecHygiene({ root, changedPaths, statusByPath, disabled, findings });
  if (checkMirrors) inspectAgentMirrors({ root, changedPaths, disabled, findings, staged });

  if (checkedFiles === 0 && findings.length === 0 && warnings.length === 0) {
    return { status: 'NOT_APPLICABLE', checkedFiles: 0, findings: [], warnings: [] };
  }
  return {
    status: findings.length > 0 ? 'FAIL' : 'PASS',
    checkedFiles,
    findings,
    warnings,
  };
}

export function runStagedGuardrails({ root = DEFAULT_ROOT } = {}) {
  let physicalRoot;
  try { physicalRoot = realpathSync(root); } catch { fail('INSUFFICIENT_EVIDENCE', `仓库根目录不可读：${root}`); }
  const config = loadSpecKitConfig(physicalRoot);
  const { paths, statusByPath } = parseChangedEntries(
    runGit(physicalRoot, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--']).stdout,
  );
  const diffChild = runGit(physicalRoot, ['diff', '--cached', '--check', '--'], { allowFailure: true });
  if (diffChild.status === 1) {
    fail('BUSINESS_FAILURE', diffChild.stdout.toString('utf8') || diffChild.stderr.toString('utf8') || 'staged diff --check 失败');
  }
  if (diffChild.status !== 0) fail('INSUFFICIENT_EVIDENCE', 'diff --cached --check 未能执行');

  const guardrails = inspectGuardrails(
    config,
    paths,
    (filePath) => addedLines(physicalRoot, ['diff', '--cached', '-U0', '--no-renames', '--', filePath]),
    { root: physicalRoot, statusByPath, checkMirrors: true, staged: true },
  );
  if (guardrails.status === 'FAIL') {
    const summary = guardrails.findings.map((f) => `[${f.rule}] ${f.path}: ${f.message}`).join('; ');
    fail('BUSINESS_FAILURE', `静态红线门禁失败：${summary}`);
  }
  return {
    passed: true,
    mode: 'staged',
    targetBranch: config.project.targetBranch,
    presets: config.presets,
    changedPaths: paths,
    guardrails,
  };
}

export function runMinimalGates({ root = DEFAULT_ROOT, targetBranch = null, testCommand = null } = {}) {
  let physicalRoot;
  try { physicalRoot = realpathSync(root); } catch { fail('INSUFFICIENT_EVIDENCE', `仓库根目录不可读：${root}`); }
  const config = loadSpecKitConfig(physicalRoot);
  const target = targetBranch || config.project.targetBranch;

  const gitDir = resolve(physicalRoot, gitText(physicalRoot, ['rev-parse', '--git-dir']));
  const commonDir = resolve(physicalRoot, gitText(physicalRoot, ['rev-parse', '--git-common-dir']));
  const linked = gitDir !== commonDir;
  const branch = runGit(physicalRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
    .stdout.toString('utf8').trim();
  if (!branch) fail('INSUFFICIENT_EVIDENCE', '当前处于 detached HEAD，拒绝门禁评估');
  if (config.project.worktreeRequired && (!linked || branch === target || branch === 'master')) {
    fail('INSUFFICIENT_EVIDENCE', `必须在基于 ${target} 的隔离 worktree 分支中验收，当前=${branch}（linked=${linked}）`);
  }
  if (gitText(physicalRoot, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    fail('INSUFFICIENT_EVIDENCE', '工作区不干净，请先提交或清理改动');
  }

  const head = gitText(physicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const targetRef = gitText(physicalRoot, ['rev-parse', '--verify', `refs/heads/${target}^{commit}`]);
  const baseCommit = gitText(physicalRoot, ['merge-base', targetRef, head]);
  if (!FULL_COMMIT.test(head) || !FULL_COMMIT.test(baseCommit)) {
    fail('INSUFFICIENT_EVIDENCE', '无法解析基线与 HEAD 提交');
  }

  const diffCheck = runGit(physicalRoot, ['diff', '--check', baseCommit, head, '--'], { allowFailure: true });
  if (diffCheck.status === 1) {
    fail('BUSINESS_FAILURE', diffCheck.stdout.toString('utf8') || diffCheck.stderr.toString('utf8') || 'git diff --check 失败');
  }
  if (diffCheck.status !== 0) fail('INSUFFICIENT_EVIDENCE', 'git diff --check 未能执行');

  const { paths: changedPaths, statusByPath } = parseChangedEntries(
    runGit(physicalRoot, ['diff', '--name-status', '-z', baseCommit, head, '--']).stdout,
  );
  const guardrails = inspectGuardrails(
    config,
    changedPaths,
    (filePath) => addedLines(physicalRoot, ['diff', '-U0', '--no-renames', baseCommit, head, '--', filePath]),
    { root: physicalRoot, statusByPath, checkMirrors: true },
  );
  if (guardrails.status === 'FAIL') {
    const summary = guardrails.findings.map((f) => `[${f.rule}] ${f.path}: ${f.message}`).join('; ');
    fail('BUSINESS_FAILURE', `静态红线门禁失败：${summary}`);
  }

  let focusedTests = { status: 'MANUAL' };
  if (testCommand) {
    const child = spawnSync(testCommand[0], testCommand.slice(1), { cwd: physicalRoot, encoding: 'utf8', shell: false });
    if (child.error) fail('INSUFFICIENT_EVIDENCE', `测试命令启动失败：${child.error.message}`);
    if (child.status !== 0) fail('BUSINESS_FAILURE', child.stderr || child.stdout || `测试退出码 ${child.status}`);
    focusedTests = { status: 'PASS', command: testCommand };
  }

  return {
    passed: true,
    mode: 'committed',
    targetBranch: target,
    branch,
    linked,
    baseCommit,
    head,
    presets: config.presets,
    changedPaths,
    guardrails,
    focusedTests,
  };
}

export function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, target: null, json: false, staged: false, testCommand: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--staged') out.staged = true;
    else if (arg === '--root' || arg === '--target') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('--')) {
        fail('INSUFFICIENT_EVIDENCE', `${arg} 缺少参数值`);
      }
      if (arg === '--root') out.root = argv[++i];
      else out.target = argv[++i];
    }
    else if (arg === '--run-tests') {
      out.testCommand = argv.slice(i + 1);
      if (out.testCommand.length === 0) fail('INSUFFICIENT_EVIDENCE', '--run-tests 缺少可执行命令');
      break;
    } else if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else {
      fail('INSUFFICIENT_EVIDENCE', `未知参数：${arg}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let jsonMode = process.argv.includes('--json');
  try {
    const args = parseArgs(process.argv.slice(2));
    jsonMode = args.json;
    if (args.help) {
      process.stdout.write('用法：node scripts/spec-gates.mjs [--root <dir>] [--target <branch>] [--staged] [--json] [--run-tests <cmd...>]\n');
      process.exit(0);
    }
    const result = args.staged
      ? runStagedGuardrails({ root: args.root })
      : runMinimalGates({ root: args.root, targetBranch: args.target, testCommand: args.testCommand });
    process.stdout.write(jsonMode ? `${JSON.stringify(result, null, 2)}\n` : `PASS (${result.mode})\n`);
  } catch (error) {
    const payload = {
      passed: false,
      failureClass: error instanceof GateError ? error.failureClass : 'INSUFFICIENT_EVIDENCE',
      message: error.message,
    };
    process.stderr.write(jsonMode ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.failureClass}: ${payload.message}\n`);
    process.exit(1);
  }
}
