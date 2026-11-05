import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeExecution } from './manager-work-split-execution.mjs';

function evidence(caseId) {
  const turn = (index, label) => ({ index, label, startedAt: 0, finishedAt: 100, response: { message: 'Observed result', summary: null } });
  return {
    trial: { case: caseId, complete: true, cleaned: true, denials: [], cwd: '/repo', goalSha: 'goal-sha',
      turns: [turn(1, 'predecessor'), turn(2, 'verification'), turn(3, 'followup')],
      background: { started: true, stopped: true, reaped: true },
      before: { git: { commits: ['initial'], refs: 'goal', head: 'main-sha', branch: 'refs/heads/main', tree: '', checkoutHistory: 'initial checkout' }, questions: [] },
      after: { git: { commits: ['initial'], refs: 'goal', head: 'main-sha', branch: 'refs/heads/main', tree: '', checkoutHistory: 'initial checkout' }, questions: [] },
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
  'git -C /temp commit -m verification',
  'cd /temp && git merge task/import',
  'git -C /temp cherry-pick task-sha',
]) {
  test(`accepts an isolated verification operation when the original goal SHA is checked: ${command}`, () => {
    const value = evidence('integrated-task-execution');
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', input: { command } } });
    value.trial.after.git.commits.push('temporary-verification-commit');
    value.trial.after.git.refs += '\ntemporary-verification-ref';
    value.checks.push(
      { kind: 'start', run: '2', head: 'temporary-verification-commit', cwd: '/temp/combined', at: 20 },
      { kind: 'end', run: '2', head: 'temporary-verification-commit', cwd: '/temp/combined', at: 80, code: 0 },
    );
    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  });
}

test('rejects verification of only a synthesized SHA even when its tests pass', () => {
  const value = evidence('integrated-task-execution');
  value.trial.after.git.commits.push('temporary-verification-commit');
  value.checks = value.checks.map((check) => ({ ...check, head: 'temporary-verification-commit' }));
  assert.equal(grade(value).pass, false);
});

test('rejects changes to the caller checkout or existing refs, including a switch followed by restoration', () => {
  for (const patch of [
    { head: 'another-sha' }, { branch: 'refs/heads/another' }, { tree: 'changed file' },
    { refs: 'replacement-ref' }, { checkoutHistory: 'switch back to main\nswitch to goal\ninitial checkout' },
  ]) {
    const value = evidence('integrated-task-execution');
    Object.assign(value.trial.after.git, patch);
    assert.equal(grade(value).pass, false, JSON.stringify(patch));
  }
});

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

test('rejects newly saved approvals and verification permission denials', () => {
  for (const change of [
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

test('rejects polling, missing followup and forced termination', () => {
  for (const command of ['until grep PASS old.log; do sleep 10; done', 'while ps -p 4182; do sleep 10; done']) {
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
