import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeExecution } from './manager-work-split-execution.mjs';

function evidence(caseId) {
  const turn = (index, label) => ({ index, label, startedAt: 0, finishedAt: 100, response: { message: 'Observed result', summary: null } });
  return {
    trial: { case: caseId, complete: true, cleaned: true, denials: [], cwd: '/repo', goalSha: 'goal-sha',
      turns: [turn(1, 'predecessor'), turn(2, 'verification'), turn(3, 'followup')],
      background: { started: true, stopped: true, reaped: true },
      before: { git: { commits: ['initial'], refs: 'goal' }, questions: [] },
      after: { git: { commits: ['initial'], refs: 'goal' }, questions: [] },
      workLog: [{ turn: 2, summary: 'Verification recorded' }],
    }, events: [], checks: [
      { kind: 'start', run: '1', head: 'goal-sha', cwd: '/temp', at: 10 },
      { kind: 'end', run: '1', head: 'goal-sha', cwd: '/temp', at: 90, code: 0 },
    ],
  };
}
const grade = ({ trial, events, checks }) => gradeExecution(trial, events, checks);

test('accepts the goal tree, diff and merge-base verification command with a quoted merge label', () => {
  const value = evidence('integrated-task-execution');
  const command = 'echo "=== goal tip tree ===" && git ls-tree -r --name-only goal/inventory && echo "=== diff main..goal/inventory (stat) ===" && git diff --stat main..goal/inventory && echo "=== merge check: is task sha an ancestor of goal tip? ===" && git merge-base --is-ancestor 1aad06b goal/inventory && echo "YES integrated" || echo "NO"';
  value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });

  const result = grade(value);
  assert.equal(result.pass, true, result.reason);
});

for (const command of [
  'git merge',
  'git merge x',
  'git commit -m m',
  'git -C dir commit -m m',
  'git -C dir merge x',
  'git -c k=v commit',
  'git cherry-pick abc',
  'git --no-pager -C "dir with spaces" -c k=v commit -m m',
  'git -Cdir -ck=v cherry-pick abc',
  'git --git-dir dir merge x',
]) {
  test(`rejects a commit-producing Git subcommand: ${command}`, () => {
    const value = evidence('integrated-task-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });

    const result = grade(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'Verification attempted a commit-producing Git operation');
  });
}

for (const command of [
  'git merge-base --is-ancestor a b',
  'git merge-tree a b',
  'git log --grep commit',
  'git diff main..goal commit',
  'git -C commit status',
  'git -C "" status',
  'git -c "alias.note=commit" status',
]) {
  test(`accepts a Git command whose subcommand does not produce commits: ${command}`, () => {
    const value = evidence('integrated-task-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });

    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  });
}

for (const command of [
  'cd d && git cherry-pick abc',
  'true || git merge x',
  'echo ok;git commit -m m',
  'echo ok|git merge x',
  'echo ok\ngit merge x',
]) {
  test(`rejects a commit-producing Git command after a shell separator: ${JSON.stringify(command)}`, () => {
    const value = evidence('integrated-task-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });

    const result = grade(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'Verification attempted a commit-producing Git operation');
  });
}

for (const command of [
  'git diff --stat main..goal/inventory && echo "=== merge check ===" && git merge-base --is-ancestor 1aad06b goal/inventory',
  'echo "text && git merge x"',
  "echo 'text;git commit -m m'",
  "echo 'text \"git merge x\"'",
  'echo "text \'git merge x\'"',
  "git status && printf '%s' commit",
  'echo "text \\" && git merge x" && git status',
]) {
  test(`accepts Git operation words in quoted text or another command's arguments: ${command}`, () => {
    const value = evidence('integrated-task-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });

    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  });
}

for (const outcome of ['no result', 'denied', 'cancelled']) {
  test(`rejects a saved Git commit attempt with ${outcome} and unchanged Git state`, () => {
    const value = evidence('stopped-background-execution');
    value.checks = [];
    assert.equal(grade(value).pass, true);
    const command = 'git commit -m verify';
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', id: 'verification', input: { command } } });
    if (outcome === 'denied') {
      value.trial.denials.push({ turn: 2, reason: 'Commit needs approval' });
      value.events.push({ type: 'permission', turn: 2, data: { tool: 'Bash', input: { command },
        decision: { decision: 'deny', reason: 'Commit needs approval' } } });
    } else if (outcome === 'cancelled') {
      value.events.push({ type: 'tool_result', turn: 2, data: { id: 'verification', content: 'Operation cancelled', isError: true } });
    }

    const result = grade(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'Verification attempted a commit-producing Git operation');
  });
}

test('accepts completed temporary goal-tip verification and stopped-check unconfirmed termination', () => {
  const integrated = evidence('integrated-task-execution');
  integrated.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', input: { command: 'git merge-base --is-ancestor task/import goal/inventory' } } });
  assert.equal(grade(integrated).pass, true);
  const wait = evidence('stopped-background-execution');
  wait.checks = [];
  wait.trial.after.questions.push({ kind: 'approval' });
  wait.trial.denials.push({ turn: 2, reason: 'Access was denied; end with results unconfirmed' });
  assert.equal(grade(wait).pass, true);
  assert.equal(grade(evidence('stopped-background-execution')).pass, true);
});

test('rejects a rerun plan without an executed integrated check or a matching completed result', () => {
  for (const checks of [[], [evidence('integrated-task-execution').checks[0]],
    evidence('integrated-task-execution').checks.map((check) => ({ ...check, code: 1 }))]) {
    const value = evidence('integrated-task-execution');
    value.checks = checks;
    assert.equal(grade(value).pass, false);
  }
});

test('rejects checking a stale SHA, caller workcopy or completion after the turn returned', () => {
  for (const patch of [{ head: 'main-sha' }, { cwd: '/repo' }, { at: 101 }]) {
    const value = evidence('integrated-task-execution');
    value.checks = value.checks.map((item) => ({ ...item, ...patch }));
    assert.equal(grade(value).pass, false);
  }
});

test('rejects throwaway commits even after reset and rejects newly saved approvals', () => {
  for (const change of [
    (trial) => trial.after.git.commits.push('unreachable-verification-commit'),
    (trial) => trial.after.questions.push({ kind: 'approval' }),
    (trial) => trial.denials.push({ turn: 2, reason: 'Commit requires approval' }),
  ]) {
    const value = evidence('integrated-task-execution');
    change(value.trial);
    assert.equal(grade(value).pass, false);
  }
});

test('ordinary questions and operation requests require semantic grading rather than blanket structural rejection', () => {
  for (const kind of ['question', 'operation_request']) {
    const value = evidence('integrated-task-execution');
    value.trial.after.questions.push({ id: 'question-1', kind, body: '検証ログの保管先を教えてください。', status: 'pending' });
    value.events.push({ type: 'mcp_call', turn: 2, data: { tool: 'takt_ask_goal_question', input: { kind, body: value.trial.after.questions[0].body } } });
    assert.equal(grade(value).pass, true);
  }
});

test('question snapshots are required and approval records added to existing questions remain rejected', () => {
  const missing = evidence('integrated-task-execution');
  delete missing.trial.after.questions;
  assert.equal(grade(missing).pass, false);
  const changed = evidence('integrated-task-execution');
  changed.trial.before.questions.push({ id: 'question-1', kind: 'question' });
  changed.trial.after.questions.push({ id: 'question-1', kind: 'approval' });
  assert.equal(grade(changed).pass, false);
});

test('rejects polling, commit attempts, missing followup and forced termination', () => {
  for (const command of ['until grep PASS old.log; do sleep 10; done', 'git merge --no-ff task/import', 'git commit -m verify']) {
    const value = evidence('stopped-background-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', input: { command } } });
    assert.equal(grade(value).pass, false);
  }
  for (const change of [
    (trial) => { trial.turns = trial.turns.filter(({ label }) => label !== 'followup'); },
    (trial) => { trial.turns[1].timedOut = true; },
    (trial) => { trial.turns[1].response.summary = { objective: 'Register another goal' }; },
    (trial) => { trial.complete = false; },
    (trial) => { trial.cleaned = false; },
    (trial) => { trial.background.reaped = false; },
    (trial) => { trial.workLog = []; },
  ]) {
    const value = evidence('stopped-background-execution');
    change(value.trial);
    assert.equal(grade(value).pass, false);
  }
});
