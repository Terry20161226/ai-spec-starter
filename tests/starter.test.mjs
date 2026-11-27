import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const STARTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INIT_SH = join(STARTER_ROOT, 'init.sh');

const temps = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
}

test('init.sh 面向 Python 仓库自动识别 presets、校验镜像防漂移并拦截坏提交', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'starter-e2e-py-'));
  temps.push(workspace);
  const repo = join(workspace, 'my-agent-repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname = "my-agent-repo"\n');
  writeFileSync(join(repo, 'agent.py'), 'def run():\n    return "ok"\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: init python repo']);

  const expectedVersion = readFileSync(join(STARTER_ROOT, 'template/.agents/.starter-version'), 'utf8').trim();
  const initRes = spawnSync('bash', [INIT_SH, repo], { encoding: 'utf8' });
  assert.equal(initRes.status, 0, `${initRes.stdout}\n${initRes.stderr}`);
  assert.match(initRes.stdout, new RegExp(`version=none -> ${expectedVersion.replaceAll('.', '\\.')}`));

  const cfg = JSON.parse(readFileSync(join(repo, '.spec-kit.json'), 'utf8'));
  assert.equal(cfg.project.targetBranch, 'main');
  assert.deepEqual(cfg.presets, ['secrets-baseline', 'python-safety']);
  assert.equal(existsSync(join(repo, '.claude/skills/direct-fix/SKILL.md')), true);
  assert.equal(existsSync(join(repo, '.qoder/commands/spec/propose.md')), true);

  // 自定义 AGENTS.md 后重跑 init.sh，验证升级不覆盖自定义内容
  writeFileSync(join(repo, 'AGENTS.md'), '# custom rules kept\n');
  const reinit = spawnSync('bash', [INIT_SH, repo], { encoding: 'utf8' });
  assert.equal(reinit.status, 0, reinit.stderr);
  assert.match(reinit.stdout, new RegExp(`version=${expectedVersion.replaceAll('.', '\\.')} -> ${expectedVersion.replaceAll('.', '\\.')}`));
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# custom rules kept\n');

  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: bootstrap ai-spec-starter']);

  // mtime 变化不破坏 update.sh --check
  spawnSync('touch', ['-t', '202501010000', join(repo, '.agents/skills/direct-fix/SKILL.md')]);
  const mirrorCheck = spawnSync('bash', ['.agents/update.sh', '--check'], { cwd: repo, encoding: 'utf8' });
  assert.equal(mirrorCheck.status, 0, `${mirrorCheck.stdout}\n${mirrorCheck.stderr}`);

  const wtOut = execFileSync('bash', ['scripts/create-worktree.sh', 'fix-agent-error'], { cwd: repo, encoding: 'utf8' });
  const wtPath = /WORKTREE_PATH=(.+)/.exec(wtOut)?.[1]?.trim();
  assert.ok(wtPath && existsSync(wtPath));

  // 修改 .agents/skills/direct-fix/SKILL.md 但未 sync 镜像 -> pre-commit 应拦下 G-AGENT-MIRROR-DRIFT
  writeFileSync(join(wtPath, '.agents/skills/direct-fix/SKILL.md'), '# drifted skill\n');
  git(wtPath, ['add', '.agents/skills/direct-fix/SKILL.md']);
  const driftCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'docs: edit skill without sync'], { cwd: wtPath, encoding: 'utf8' });
  assert.notEqual(driftCommit.status, 0);
  assert.match(driftCommit.stderr, /G-AGENT-MIRROR-DRIFT/);
  // 运行了 update.sh 同步工作区，但只暂存 .agents/ 忘了暂存 .claude/.qoder -> 仍应被 pre-commit 拦下
  execFileSync('bash', ['.agents/update.sh'], { cwd: wtPath });
  git(wtPath, ['add', '.agents/skills/direct-fix/SKILL.md']);
  const unstagedMirrorCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'docs: forget staging synced mirrors'], { cwd: wtPath, encoding: 'utf8' });
  assert.notEqual(unstagedMirrorCommit.status, 0);
  assert.match(unstagedMirrorCommit.stderr, /未加入暂存区/);
  git(wtPath, ['checkout', 'HEAD', '--', '.agents/skills/direct-fix/SKILL.md']);
  execFileSync('bash', ['.agents/update.sh'], { cwd: wtPath });

  // bare except 被 pre-commit 拦截，修复后提交通过
  writeFileSync(join(wtPath, 'agent.py'), 'def run():\n    try:\n        return "ok"\n    except:\n        return "bad"\n');
  git(wtPath, ['add', 'agent.py']);
  const blockedCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'fix: bad except'], { cwd: wtPath, encoding: 'utf8' });
  assert.notEqual(blockedCommit.status, 0);
  assert.match(blockedCommit.stderr, /G-PY-BARE-EXCEPT/);

  writeFileSync(join(wtPath, 'agent.py'), 'def run():\n    try:\n        return "ok"\n    except RuntimeError:\n        return "err"\n');
  git(wtPath, ['add', 'agent.py']);
  const goodCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'fix: catch RuntimeError'], { cwd: wtPath, encoding: 'utf8' });
  assert.equal(goodCommit.status, 0, `${goodCommit.stdout}\n${goodCommit.stderr}`);

  const gateOut = execFileSync('node', ['scripts/spec-gates.mjs', '--json'], { cwd: wtPath, encoding: 'utf8' });
  assert.equal(JSON.parse(gateOut).passed, true);

  // 从 linked worktree 内部再执行 create-worktree.sh，路径应紧邻主仓而非多层 -wt- 嵌套
  const siblingOut = execFileSync('bash', ['scripts/create-worktree.sh', 'fix-sibling'], { cwd: wtPath, encoding: 'utf8' });
  const siblingPath = /WORKTREE_PATH=(.+)/.exec(siblingOut)?.[1]?.trim();
  assert.equal(siblingPath, join(realpathSync(workspace), 'my-agent-repo-wt-fix-sibling'));
});

test('init.sh 面向 Java+develop 仓库自动识别并验证真实 git push 触发 pre-push Hook', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'starter-e2e-java-'));
  temps.push(workspace);
  const bare = join(workspace, 'remote.git');
  const repo = join(workspace, 'java-service');
  mkdirSync(bare, { recursive: true });
  mkdirSync(join(repo, 'src/main/java/com/demo'), { recursive: true });
  git(bare, ['init', '--bare']);

  git(repo, ['init', '-b', 'develop']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', bare]);
  writeFileSync(join(repo, 'pom.xml'), '<project/>\n');
  writeFileSync(join(repo, 'src/main/java/com/demo/App.java'), 'package com.demo;\nclass App {}\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: init java repo']);

  const initRes = spawnSync('bash', [INIT_SH, repo], { encoding: 'utf8' });
  assert.equal(initRes.status, 0, initRes.stderr);
  const cfg = JSON.parse(readFileSync(join(repo, '.spec-kit.json'), 'utf8'));
  assert.equal(cfg.project.targetBranch, 'develop');
  assert.deepEqual(cfg.presets, ['secrets-baseline', 'java-jakarta', 'sql-flyway']);

  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: bootstrap starter']);
  git(repo, ['push', '-u', 'origin', 'develop']);

  const wtOut = execFileSync('bash', ['scripts/create-worktree.sh', 'add-controller'], { cwd: repo, encoding: 'utf8' });
  const wtPath = /WORKTREE_PATH=(.+)/.exec(wtOut)?.[1]?.trim();
  assert.ok(wtPath);

  // 验证 javax.* 在 pre-commit 即刻拦截
  writeFileSync(join(wtPath, 'src/main/java/com/demo/App.java'), 'package com.demo;\nimport javax.servlet.Filter;\nclass App {}\n');
  git(wtPath, ['add', 'src/main/java/com/demo/App.java']);
  const javaxCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'feat: bad javax'], { cwd: wtPath, encoding: 'utf8' });
  assert.notEqual(javaxCommit.status, 0);
  assert.match(javaxCommit.stderr, /G-JAVA-JAKARTA/);

  // 改为 jakarta.* 提交成功，并绕过一次 commit 后也验证真实 git push -> pre-push Hook 通过
  writeFileSync(join(wtPath, 'src/main/java/com/demo/App.java'), 'package com.demo;\nimport jakarta.servlet.Filter;\nclass App {}\n');
  git(wtPath, ['add', 'src/main/java/com/demo/App.java']);
  assert.equal(spawnSync('/usr/bin/git', ['commit', '-m', 'feat: use jakarta'], { cwd: wtPath, encoding: 'utf8' }).status, 0);

  const pushOk = spawnSync('/usr/bin/git', ['push', '-u', 'origin', 'spec/add-controller'], { cwd: wtPath, encoding: 'utf8' });
  assert.equal(pushOk.status, 0, `${pushOk.stdout}\n${pushOk.stderr}`);

  // 再刻意提交一个绕过 pre-commit (SKIP_SPEC_GATES=1) 的坏提交，验证 git push 会被 pre-push 兜底拦下！
  writeFileSync(join(wtPath, 'src/main/java/com/demo/App.java'), 'package com.demo;\nimport javax.servlet.Filter;\nclass App {}\n');
  git(wtPath, ['add', 'src/main/java/com/demo/App.java']);
  const bypassCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'wip: bypass local hook'], {
    cwd: wtPath,
    env: { ...process.env, SKIP_SPEC_GATES: '1' },
    encoding: 'utf8',
  });
  assert.equal(bypassCommit.status, 0);

  const pushBlocked = spawnSync('/usr/bin/git', ['push', 'origin', 'spec/add-controller'], { cwd: wtPath, encoding: 'utf8' });
  assert.notEqual(pushBlocked.status, 0);
  assert.match(pushBlocked.stderr, /G-JAVA-JAKARTA/);
});

test('init.sh 支持 0 提交全新空仓库（unborn HEAD）并放行首次合规提交', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'starter-e2e-empty-'));
  temps.push(workspace);
  const repo = join(workspace, 'brand-new-ts');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'package.json'), '{"name":"brand-new-ts","private":true}\n');

  const initRes = spawnSync('bash', [INIT_SH, repo], { encoding: 'utf8' });
  assert.equal(initRes.status, 0, `${initRes.stdout}\n${initRes.stderr}`);
  git(repo, ['add', '.']);
  const firstCommit = spawnSync('/usr/bin/git', ['commit', '-m', 'chore: initial commit'], { cwd: repo, encoding: 'utf8' });
  assert.equal(firstCommit.status, 0, `${firstCommit.stdout}\n${firstCommit.stderr}`);
});
