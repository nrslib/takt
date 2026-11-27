import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendGoalWorkLog } from '../../dist/infra/goals/workLog.js';
import { loadManagerCase } from '../manager-work-split-prompt.mjs';

export const noWaitExecutionCases = new Set(['two-goal-pr-execution', 'finite-check-external-execution']);

export async function prepareNoWaitFixture(state, root, checksPath, config) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const observer = `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
const watch = args.includes('watch') || args.includes('--watch');
appendFileSync(${JSON.stringify(checksPath)}, JSON.stringify({kind:'external', at:Date.now(), args, watch})+'\\n');
console.log(JSON.stringify({status:'in_progress', conclusion:null, state:'OPEN', ready:false, statusCheckRollup:[{status:'IN_PROGRESS',conclusion:null}]}));
`;
  const observerPath = join(root, 'external-status.mjs');
  writeFileSync(observerPath, observer);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}\n${observer}`);
  chmodSync(gh, 0o755);
  state.goals = [state.goal];
  state.tasks = [];
  if (config.case === 'two-goal-pr-execution') {
    const template = loadManagerCase('approve-unprepared-pr', config.lang).goal;
    const first = { ...template, id: state.goal.id, branch: state.goal.branch,
      objective: config.lang === 'ja' ? '在庫ヘルプを仕上げる' : 'Finish inventory help',
      acceptanceCriteria: ['Inventory help matches the existing inventory command.'],
      workLog: [], completion: { ...template.completion, goalBranch: state.goal.branch, goalSha: state.goalSha, humanChecks: 'Read inventory help.' } };
    const second = { ...first, id: '650e8400-e29b-41d4-a716-446655440001', branch: 'goal/export',
      objective: config.lang === 'ja' ? '独立したエクスポートのヘルプを仕上げる' : 'Finish independent export help',
      acceptanceCriteria: ['Export help matches the existing export command.'],
      pullRequest: { number: 1951, url: 'https://github.com/example/project/pull/1951' },
      completion: { ...first.completion, goalBranch: 'goal/export', humanChecks: 'Read export help.' } };
    await state.store.update(first.id, () => first);
    await state.store.create(second);
    state.goal = first;
    state.goals = [first, second];
    state.tasks = [{ name: 'prepare-inventory', goalId: first.id, status: 'running', workflow: 'merge-prepare',
      goalIntegration: 'direct_push', runSlug: 'prepare-inventory', currentStep: 'wait_ci',
      goalPurpose: 'Prepare saved PR #1950 without merging', prNumber: 1950, until: 'prepare' }];
    await state.store.update(first.id, (value) => appendGoalWorkLog(value, { summary: 'PR #1950: prepare-inventory is already running with until: prepare.' }));
    await state.store.update(second.id, (value) => appendGoalWorkLog(value, { summary: 'PR #1951: CI in_progress. No finishing task has been submitted.' }));
  } else {
    await state.store.update(state.goal.id, (value) => ({ ...value,
      objective: config.lang === 'ja' ? '在庫の有限のテストと外部公開状態を確認する' : 'Check finite inventory tests and external publication status',
      acceptanceCriteria: ['npm test passes at the goal tip.', 'External publication is ready.'],
      constraints: ['Verification only. No code changes, new tasks or human decisions are needed.'],
      workLog: [],
    }));
    await state.store.update(state.goal.id, (value) => appendGoalWorkLog(value, {
      summary: `Goal tip: ${state.goalSha}. Run npm test in a temporary checkout; no dependencies are needed. External publication has no corresponding event. Its status is available with node ${observerPath}; the current status is not ready.`,
    }));
    state.goal = await state.store.get(state.goal.id);
    state.goals = [state.goal];
  }
  return { bin, observerPath };
}
