import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { inspectGuardrails, parseArgs, runMinimalGates, runStagedGuardrails } from './spec-gates.mjs';

const temps = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
}

test('preset 规则覆盖 java / ts(含左值赋值) / python(含yaml.load) / secrets / sql', () => {
  const cfg = {
    project: { targetBranch: 'main', worktreeRequired: false },
    presets: ['java-jakarta', 'ts-no-float-money', 'python-safety', 'sql-flyway', 'secrets-baseline'],
    paths: {
      migrationRegex: 'migrations/.*\\.sql$',
      javaSourceRegex: '\\.java$',
      tsSourceRegex: '\\.tsx?$',
      pythonSourceRegex: '\\.py$',
      ignoreTestRegex: '_test\\.py$|\\.test\\.ts$',
    },
    disableGuardrails: [],
    customGuardrails: [{
      id: 'NO-PRINT',
      files: '\\.py$',
      pattern: '\\bprint\\(',
      severity: 'error',
      message: '禁止 print',
    }],
  };

  const added = {
    'src/App.java': ['+import javax.servlet.http.HttpServletRequest;'],
    'src/calc.ts': [
      '+const sum = Number(orderAmount) + 1;',
      '+const totalAmount = parseFloat(rawInput);',
      '+const fee: number = Number(rawFee);',
      '+// Number(orderAmount) 注释放行',
    ],
    'src/agent.py': ['+except:', '+api_key = "sk-1234567890abcdef"', '+cfg = yaml.load(raw)', '+print("debug")'],
    'src/agent_test.py': ['+print("allowed in test")'],
    'migrations/V1__init.sql': ['+CREATE TABLE t_demo (id BIGINT);'],
  };

  const res = inspectGuardrails(cfg, Object.keys(added), (p) => added[p] ?? []);
  assert.equal(res.status, 'FAIL');
  const rules = new Set(res.findings.map((f) => f.rule));
  assert.ok(rules.has('G-JAVA-JAKARTA'));
  assert.ok(rules.has('G-TS-NO-FLOAT-MONEY'));
  assert.ok(rules.has('G-PY-BARE-EXCEPT'));
  assert.ok(rules.has('G-PY-HARDCODED-SECRET'));
  assert.ok(rules.has('G-PY-UNSAFE-YAML'));
  assert.ok(rules.has('NO-PRINT'));
  assert.equal(res.findings.filter((f) => f.rule === 'G-TS-NO-FLOAT-MONEY').length, 3);
  assert.equal(res.findings.some((f) => f.path === 'src/agent_test.py'), false);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].rule, 'G-SQL-TABLE-SYSTEM-COLS');
});

test('sql-flyway 拦截重复版本迁移与原地篡改已提交迁移，并拦截含占位符的 spec', () => {
  const base = mkdtempSync(join(tmpdir(), 'spec-gates-flyway-'));
  temps.push(base);
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'migrations'), { recursive: true });
  mkdirSync(join(repo, 'openspec/specs/order'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, '.spec-kit.json'), JSON.stringify({
    project: { name: 'demo', targetBranch: 'main', worktreeRequired: true },
    presets: ['sql-flyway'],
  }));
  writeFileSync(join(repo, 'migrations/V1__init.sql'), 'CREATE TABLE t_a (id BIGINT, is_deleted INT, created_at TIMESTAMP);\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);

  const wt = join(base, 'repo-wt-mig');
  git(repo, ['worktree', 'add', '-b', 'spec/mig', wt, 'main']);

  // 1. 修改已有 V1 迁移应触发 G-SQL-IMMUTABLE-MIGRATION
  writeFileSync(join(wt, 'migrations/V1__init.sql'), 'CREATE TABLE t_a (id BIGINT, x INT, is_deleted INT, created_at TIMESTAMP);\n');
  git(wt, ['add', 'migrations/V1__init.sql']);
  assert.throws(() => runStagedGuardrails({ root: wt }), /G-SQL-IMMUTABLE-MIGRATION/);
  git(wt, ['checkout', 'HEAD', '--', 'migrations/V1__init.sql']);

  // 2. 子目录冲突版本号 migrations/sub/V1_0__dup.sql 应触发 G-SQL-DUPLICATE-VERSION
  mkdirSync(join(wt, 'migrations/sub'), { recursive: true });
  writeFileSync(join(wt, 'migrations/sub/V1_0__dup.sql'), 'CREATE TABLE t_b (id BIGINT, is_deleted INT, created_at TIMESTAMP);\n');
  git(wt, ['add', 'migrations/sub/V1_0__dup.sql']);
  assert.throws(() => runStagedGuardrails({ root: wt }), /G-SQL-DUPLICATE-VERSION/);
  rmSync(join(wt, 'migrations/sub'), { recursive: true, force: true });
  git(wt, ['reset', 'HEAD', '--', 'migrations/sub/V1_0__dup.sql']);

  // 3. 含 ## Purpose + ## ADDED Requirements 的 delta spec 若带 TODO 仍触发 G-SPEC-HYGIENE
  mkdirSync(join(wt, 'openspec/specs/order'), { recursive: true });
  writeFileSync(join(wt, 'openspec/specs/order/spec.md'), '## Purpose\n\nTBD\n\n## ADDED Requirements\n\n### Requirement: demo\n\n#### Scenario: ok\n- **WHEN** x\n- **THEN** y\n\nTODO\n');
  git(wt, ['add', 'openspec/specs/order/spec.md']);
  assert.throws(() => runStagedGuardrails({ root: wt }), /G-SPEC-HYGIENE/);

  // 4. 修正迁移与 spec 后正常通过
  writeFileSync(join(wt, 'migrations/V2__order_log.sql'), 'CREATE TABLE t_b (id BIGINT, is_deleted INT, created_at TIMESTAMP);\n');
  writeFileSync(join(wt, 'openspec/specs/order/spec.md'), '### Requirement: demo\n\n#### Scenario: ok\n- **WHEN** x\n- **THEN** y\n');
  git(wt, ['add', '.']);
  const staged = runStagedGuardrails({ root: wt });
  assert.equal(staged.passed, true);
  git(wt, ['commit', '-m', 'feat: add V2 migration']);
  assert.equal(runMinimalGates({ root: wt }).passed, true);
});

test('parseArgs 拦截缺失参数值，customGuardrails 报错清晰且拦截明文私钥', () => {
  assert.throws(() => parseArgs(['--target']), /缺少参数值/);
  assert.throws(() => parseArgs(['--root']), /缺少参数值/);
  const pem = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
  const badCfg = {
    project: { targetBranch: 'main', worktreeRequired: false },
    presets: ['secrets-baseline'],
    paths: { migrationRegex: 'a', javaSourceRegex: 'b', tsSourceRegex: 'c', pythonSourceRegex: 'd' },
    disableGuardrails: [],
    customGuardrails: [{ id: 'BAD-RE', pattern: '[' }],
  };
  assert.throws(() => inspectGuardrails(badCfg, ['k.txt'], () => [`+${pem}`]), /customGuardrails\[BAD-RE\] 正则非法/);

  const secCfg = { ...badCfg, customGuardrails: [] };
  const secRes = inspectGuardrails(secCfg, ['key.pem'], () => [`+${pem}`]);
  assert.equal(secRes.status, 'FAIL');
  assert.equal(secRes.findings[0].rule, 'G-SEC-PRIVATE-KEY');
});
