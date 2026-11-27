import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeExecution } from './manager-work-split-execution.mjs';
import { sdkMessageToStreamEvent } from '../../dist/infra/claude/stream-converter.js';

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

function noWaitEvidence(caseId) {
  const value = evidence(caseId);
  value.trial.initialTasks = [{ name: 'already-submitted' }];
  value.trial.goals = [{ id: 'first' }, { id: 'second', pullRequest: { number: 1951 } }];
  value.trial.finalTasks = [{ name: 'already-submitted' }, { goalId: 'second', until: 'prepare' }];
  if (caseId === 'two-goal-pr-execution') {
    value.events.push({ type: 'mcp_call', turn: 2, data: { tool: 'takt_merge_goal_pr', input: { goalId: 'second', prNumber: 1951, until: 'prepare' } } });
  }
  if (caseId === 'finite-check-external-execution') value.events.push(
    { type: 'tool_use', turn: 2, at: 10, data: { tool: 'Bash', id: 'test', input: { command: 'npm test' } } },
    { type: 'tool_result', turn: 2, at: 95, data: { id: 'test', content: 'PASS inventory import\n[TAKT_CHECK_RESULT:1]', isError: false } },
  );
  value.checks.push({ kind: 'external', args: ['pr', 'view', '1951'], watch: false, at: 40 });
  return value;
}

for (const caseId of ['two-goal-pr-execution', 'finite-check-external-execution']) {
  test(`${caseId}: grades external waiting by observations rather than sleep text or duration`, () => {
    const value = noWaitEvidence(caseId);
    value.events.push({ type: 'tool_use', turn: 2, data: { tool: 'Bash', input: { command: 'echo "sleep and gh run watch are mentioned in this document"' } } });
    value.trial.turns[1].finishedAt = 100000000;
    assert.equal(grade(value).pass, true);
    for (const observation of [
      { args: ['run', 'watch', '9001'], watch: true },
      { args: ['pr', 'view', '1951'], watch: false },
    ]) {
      const invalid = structuredClone(value);
      invalid.checks.push({ kind: 'external', ...observation, at: 50 });
      assert.equal(grade(invalid).pass, false);
    }
    const missingFollowup = structuredClone(value);
    missingFollowup.trial.turns.pop();
    assert.equal(grade(missingFollowup).pass, false);
    // Reading workflow details is recorded separately and is not a pass requirement.
    value.events.push({ type: 'mcp_call', turn: 2, data: { tool: 'takt_get_workflow', input: { workflow: 'merge-prepare' } } });
    assert.equal(grade(value).pass, true);
  });

  test(`${caseId}: accepts different fields and targets queried once each`, () => {
    const value = noWaitEvidence(caseId);
    value.checks = value.checks.filter(({ kind }) => kind !== 'external');
    for (const args of [
      ['pr', 'view', '1951', '--json', 'headRefName,baseRefName'],
      ['pr', 'view', '1951', '--json', 'statusCheckRollup'],
      ['pr', 'view', '1950', '--json', 'statusCheckRollup'],
      ['run', 'view', '9001', '--json', 'status'],
      ['run', 'view', '9001', '--json', 'conclusion'],
    ]) value.checks.push({ kind: 'external', args, watch: false, at: 40 });
    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  });

  test(`${caseId}: rejects repeated state checks while allowing repeated metadata reads`, () => {
    for (const [field, pass] of [['headRefName,baseRefName', true], ['statusCheckRollup', false]]) {
      for (const jsonArgs of [['--json', field], [`--json=${field}`]]) {
        const value = noWaitEvidence(caseId);
        value.checks = value.checks.filter(({ kind }) => kind !== 'external');
        for (const at of [40, 50]) value.checks.push({ kind: 'external', args: ['pr', 'view', '1951', ...jsonArgs], watch: false, at });
        assert.equal(grade(value).pass, pass, JSON.stringify(jsonArgs));
      }
    }
  });

  test(`${caseId}: treats --json without fields as an external state query`, () => {
    for (const jsonArgs of [['--json'], ['--json', ''], ['--json=']]) {
      const value = noWaitEvidence(caseId);
      value.checks = value.checks.filter(({ kind }) => kind !== 'external');
      const observation = { kind: 'external', args: ['pr', 'view', '1951', ...jsonArgs], watch: false, at: 40 };
      value.checks.push(observation);
      const single = grade(value);
      assert.equal(single.pass, true, single.reason);

      value.checks.push({ ...observation, at: 50 });
      const repeated = grade(value);
      assert.equal(repeated.pass, false, JSON.stringify(jsonArgs));
    }
  });

  test(`${caseId}: accepts the same external state query once per returned turn`, () => {
    const value = noWaitEvidence(caseId);
    value.trial.turns[0].startedAt = -100;
    value.trial.turns[0].finishedAt = -1;
    value.trial.turns[2].startedAt = 101;
    value.trial.turns[2].finishedAt = 200;
    const observation = value.checks.find(({ kind }) => kind === 'external');
    for (const [turn, at] of [[1, -50], [3, 140]]) {
      value.checks.push({ ...observation, at });
      value.events.push({ type: 'tool_use', turn, at, data: { tool: 'Bash', input: { command: 'gh pr view 1951' } } });
      value.trial.workLog.push({ turn, summary: 'Queried publication state once; unconfirmed. Returning this turn.' });
    }
    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  });

  test(`${caseId}: rejects repeated external state queries within the followup turn`, () => {
    const value = noWaitEvidence(caseId);
    value.trial.turns[0].startedAt = -100;
    value.trial.turns[0].finishedAt = -1;
    value.trial.turns[2].startedAt = 101;
    value.trial.turns[2].finishedAt = 200;
    const observation = value.checks.find(({ kind }) => kind === 'external');
    for (const at of [140, 150]) value.checks.push({ ...observation, at });
    assert.equal(grade(value).pass, false);
  });

  test(`${caseId}: rejects a single watch observation or Bash watch command in every turn`, () => {
    for (const [turn, at] of [[1, -50], [2, 40], [3, 140]]) {
      for (const command of [undefined, 'gh run watch 9001', 'gh pr checks 1951 --watch']) {
        const value = noWaitEvidence(caseId);
        Object.assign(value.trial.turns[0], { startedAt: -100, finishedAt: -1 });
        Object.assign(value.trial.turns[2], { startedAt: 101, finishedAt: 200 });
        if (command === undefined) {
          value.checks.push({ kind: 'external', args: ['run', 'watch', '9001'], watch: true, at });
        } else {
          value.events.push({ type: 'tool_use', turn, at, data: { tool: 'Bash', input: { command } } });
        }
        assert.equal(grade(value).pass, false, `turn=${turn}, command=${command}`);
      }
    }
  });
}

test('two-goal preparation rejects duplicate submissions, wrong until, missing enqueue and missing saved task', () => {
  for (const change of [
    (value) => value.events.push(structuredClone(value.events[0])),
    (value) => { value.events[0].data.input.until = 'merge'; },
    (value) => { value.events[0].data.input.goalId = 'first'; },
    (value) => { value.events = []; },
    (value) => { value.trial.finalTasks.pop(); },
  ]) {
    const value = noWaitEvidence('two-goal-pr-execution');
    change(value);
    assert.equal(grade(value).pass, false);
  }
});

test('finite checks require completion without unnecessary inquiries or tasks', () => {
  for (const change of [
    (value) => { value.checks = value.checks.filter(({ kind }) => kind !== 'end'); },
    (value) => { value.events = value.events.filter(({ type }) => type !== 'tool_result'); },
    (value) => value.events.push({ type: 'mcp_call', turn: 2, data: { tool: 'takt_enqueue_goal_task', input: {} } }),
    (value) => value.events.push({ type: 'mcp_call', turn: 2, data: { tool: 'takt_ask_goal_question', input: {} } }),
  ]) {
    const value = noWaitEvidence('finite-check-external-execution');
    change(value);
    assert.equal(grade(value).pass, false);
  }
});

test('finite checks reject unrelated Bash and TaskOutput results after test completion', () => {
  for (const tool of ['Bash', 'TaskOutput']) {
    const value = noWaitEvidence('finite-check-external-execution');
    value.events = value.events.filter(({ type }) => type !== 'tool_result');
    value.events.push(
      { type: 'tool_use', turn: 2, at: 91, data: { tool, id: 'status', input: tool === 'Bash' ? { command: 'gh pr view 1951' } : { task_id: 'other' } } },
      { type: 'tool_result', turn: 2, at: 95, data: { id: 'status', content: 'in_progress', isError: false } },
    );
    assert.equal(grade(value).pass, false);
  }
});

test('finite checks require the matching run marker, tool ID and result time for every check', () => {
  for (const change of [
    (value) => { value.events[1].data.content = 'PASS inventory import\n[TAKT_CHECK_RESULT:other-run]'; },
    (value) => { value.events[1].data.id = 'unknown'; },
    (value) => { delete value.events[0].data.id; delete value.events[1].data.id; },
    (value) => { value.events[1].at = 89; },
    (value) => { value.events[1].at = 101; },
    (value) => { value.events[1].data.isError = true; },
    (value) => value.checks.push(...value.checks.filter(({ kind }) => kind !== 'external').map((check) => ({ ...check, run: '2' }))),
  ]) {
    const value = noWaitEvidence('finite-check-external-execution');
    change(value);
    assert.equal(grade(value).pass, false);
  }
});

test('finite checks accept the matching result from TaskOutput including batched completed tool IDs', () => {
  for (const batched of [false, true]) {
    const value = noWaitEvidence('finite-check-external-execution');
    value.events[1].data = { id: 'test', content: 'Running in background: finite-task', isError: false };
    value.events.push(
      { type: 'tool_use', turn: 2, at: 91, data: { tool: 'TaskOutput', id: 'output', input: { task_id: 'finite-task' } } },
      { type: 'tool_result', turn: 2, at: 95, data: {
        id: batched ? 'other' : 'output', ...(batched ? { completedToolIds: ['other', 'output'] } : {}),
        content: batched ? JSON.stringify({ task: { output: 'PASS inventory import\n[TAKT_CHECK_RESULT:1]' } }) : 'PASS inventory import\n[TAKT_CHECK_RESULT:1]', isError: false,
      } },
    );
    const result = grade(value);
    assert.equal(result.pass, true, result.reason);
  }
});

test('finite checks accept successful Bash stdout after production Claude stream conversion', () => {
  const value = noWaitEvidence('finite-check-external-execution');
  value.events = value.events.filter(({ type }) => type !== 'tool_result');
  sdkMessageToStreamEvent({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'test', content: 'Bash completed' }] },
    tool_use_result: { stdout: 'PASS inventory import\n[TAKT_CHECK_RESULT:1]', stderr: '', is_error: false },
    session_id: 'session-1', parent_tool_use_id: null,
  }, (event) => value.events.push({ ...event, turn: 2, at: 95 }), true);

  const result = grade(value);
  assert.equal(result.pass, true, result.reason);
});


test('finite checks may leave external status unconfirmed without making a new query', () => {
  const value = noWaitEvidence('finite-check-external-execution');
  value.checks = value.checks.filter(({ kind }) => kind !== 'external');
  assert.equal(grade(value).pass, true);
});
