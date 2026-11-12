import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import { formatManagerEpicDetail } from '../features/manager/ManagerEpicDialog.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { Epic } from '../infra/epics/index.js';
import { EpicSnapshotSchema, type EpicSnapshot } from '../infra/epics/projection.js';
import { applyEpicVerificationResult, beginEpicVerification, epicView, finishEpic, reviseEpic } from '../infra/epics/state.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { epicRecord, epicWorkspaceId, verificationResultFor, verificationRunId, verificationStartedAt } from './helpers/epic-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { cwd, DOWN, ENTER, ESC, GOAL_MENU, ManagerClientDouble, QUESTION_MENU, UP, waitFor } from './helpers/manager-tui-fixtures.js';

const EPIC_MENU = '\x0f';
const secondRepository = '/test/second-repository';
const assignment: ManagerAssignment = { kind: 'workspace', workspaceId: epicWorkspaceId,
  name: 'Epic workspace', repositoryDirectories: [cwd, secondRepository] };

function memberEpic(): Epic {
  // 同じゴールIDが別リポジトリにある場合も、それぞれの進捗とSHAを表示する。
  const members = [cwd, secondRepository].map((repositoryDirectory) => ({ repositoryDirectory, goalId: goalRecord().id }));
  return { ...epicRecord(), members,
    targets: members.map((member, index) => ({ ...member, targetSha: (index === 0 ? 'b' : 'c').repeat(40) })) };
}

function snapshot(epic: Epic, memberProgress: EpicSnapshot['memberProgress']): EpicSnapshot {
  const view = epicView(epic);
  return EpicSnapshotSchema.parse({ kind: 'epic', epic: view, memberProgress,
    recovery: view.runningVerification === undefined ? [] : [view.runningVerification] });
}

function progress(epic: Epic): EpicSnapshot['memberProgress'] {
  return epic.members.map((member) => ({ ...member, status: 'completed', executionStatus: 'active' }));
}

function mountEpics(items: EpicSnapshot[], lang: 'en' | 'ja') {
  const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment }, ...items] });
  client.change({ state: { ...client.getSnapshot().state!, assignment: { kind: 'workspace', workspaceId: epicWorkspaceId } } });
  const app = render(createElement(ManagerView, { cwd, lang, client, assignment, initialDiagnostics: [], onExit: vi.fn() }));
  Object.defineProperty(app.stdout, 'columns', { configurable: true, value: 160 });
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 80 });
  app.stdout.emit('resize');
  const replace = (next: EpicSnapshot[]): void => client.change({ items: [{ kind: 'assignment', assignment }, ...next] });
  return { app, client, replace };
}

async function openList(app: ReturnType<typeof render>, objective: string): Promise<void> {
  await waitFor(() => expect(app.lastFrame()).toContain('╭'));
  app.stdin.write(EPIC_MENU);
  await waitFor(() => expect(app.lastFrame()).toContain(objective));
}

async function openDetail(app: ReturnType<typeof render>, epic: Epic): Promise<void> {
  await openList(app, epic.objective);
  app.stdin.write(ENTER);
  await waitFor(() => expect(app.lastFrame()).toContain(epic.targets[0]!.targetSha));
}

function currentEvidenceRow(app: ReturnType<typeof render>): string {
  const row = app.lastFrame()!.split('\n').find((line) => /current.*evidence|現在.*証拠/iu.test(line));
  expect(row, '現在の証拠を履歴と区別して表示する').toBeDefined();
  return row!;
}

describe.each(['en', 'ja'] as const)('manager Epic navigation (%s)', (lang) => {
  it('opens the list and detail with per-repository progress and fixed target SHAs', async () => {
    const epic = memberEpic();
    const members = progress(epic).map((member, index) => index === 0 ? member : { ...member, status: 'created', executionStatus: 'aborted' });
    const { app, client } = mountEpics([snapshot(epic, members)], lang);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', lang)));
    expect(app.lastFrame()).not.toContain(epic.objective);
    await openList(app, epic.objective);
    expect(app.lastFrame()).toMatch(/1\s*\/\s*2/u);
    app.stdin.write(ENTER);
    await waitFor(() => {
      for (const target of epic.targets) {
        expect(app.lastFrame()).toContain(target.repositoryDirectory);
        expect(app.lastFrame()).toContain(target.goalId);
        expect(app.lastFrame()).toContain(target.targetSha);
      }
      expect(app.lastFrame()).toMatch(/completed|完了/iu);
      expect(app.lastFrame()).toMatch(/aborted|中止/iu);
    });
    app.stdin.write(ESC);
    await waitFor(() => {
      expect(app.lastFrame()).toContain(epic.objective);
      expect(app.lastFrame()).not.toContain(epic.targets[0]!.targetSha);
    });
    app.stdin.write(ESC);
    await waitFor(() => expect(app.lastFrame()).not.toContain(epic.objective));
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('updates the already open list when member progress changes and keeps pending verification visible after all goals complete', async () => {
    const epic = memberEpic();
    const members = progress(epic);
    const { app, replace, client } = mountEpics([snapshot(epic, [members[0]!, { ...members[1]!, status: 'created' }])], lang);
    await openList(app, epic.objective);
    expect(app.lastFrame()).toMatch(/1\s*\/\s*2/u);
    replace([snapshot(epic, members)]);
    await waitFor(() => {
      expect(app.lastFrame()).toMatch(/2\s*\/\s*2/u);
      expect(app.lastFrame()).toContain(epic.objective);
    });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('selects completed and aborted Epics with the same objective by their identity and retains detached history', async () => {
    const started = beginEpicVerification(memberEpic(), verificationRunId, verificationStartedAt);
    const completed = finishEpic(applyEpicVerificationResult(started.epic, verificationResultFor(started.run)));
    const aborted: Epic = { ...memberEpic(), id: '750e8400-e29b-41d4-a716-446655440000', status: 'aborted',
      targets: memberEpic().targets.map((target) => ({ ...target, targetSha: 'd'.repeat(40) })) };
    const { app, client } = mountEpics([snapshot(completed, []), snapshot(aborted, [])], lang);
    await openList(app, completed.objective);
    app.stdin.write(DOWN);
    app.stdin.write(ENTER);
    await waitFor(() => expect(app.lastFrame()).toContain('d'.repeat(40)));
    expect(app.lastFrame()).toMatch(/aborted|中止/iu);
    app.stdin.write(ESC);
    await waitFor(() => expect(app.lastFrame()).not.toContain('d'.repeat(40)));
    app.stdin.write('\x1b[A');
    app.stdin.write(ENTER);
    await waitFor(() => expect(app.lastFrame()).toContain(completed.targets[0]!.targetSha));
    expect(app.lastFrame()).toContain(started.run.id);
    expect(app.lastFrame()).toMatch(/unknown|unavailable|not (?:available|loaded)|未取得|不明/iu);
    expect(client.submit).not.toHaveBeenCalled();
  });
});

it('refreshes the same open detail after evidence invalidation, member changes and a delayed stale success', async () => {
  const started = beginEpicVerification(memberEpic(), verificationRunId, verificationStartedAt);
  const verified = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
  const { app, replace } = mountEpics([snapshot(verified, progress(verified))], 'en');
  await openDetail(app, verified);
  expect(currentEvidenceRow(app)).toContain(started.run.id);

  const reason = 'Replace the API member for a correction';
  const member = { repositoryDirectory: cwd, goalId: randomUUID() };
  const revised = reviseEpic(verified, { members: [...verified.members, member] },
    { kind: 'member_added', member, reason, recordedAt: verificationStartedAt });
  replace([snapshot(revised, [...progress(verified), { ...member, status: 'created', executionStatus: 'active' }])]);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(reason);
    expect(app.lastFrame()).toContain(member.goalId);
    expect(app.lastFrame()).toMatch(/2\s*\/\s*3/u);
    expect(currentEvidenceRow(app)).not.toContain(started.run.id);
  });

  const fixed = { ...revised, targets: [...revised.targets, { ...member, targetSha: 'e'.repeat(40) }] };
  const old = beginEpicVerification(fixed, randomUUID(), verificationStartedAt);
  const invalidated = reviseEpic(old.epic, { verificationProcedure: { version: 2, steps: ['Recheck corrected members'] } },
    { kind: 'definition', reason: 'Update verification procedure', recordedAt: verificationStartedAt });
  const current = beginEpicVerification(invalidated, randomUUID(), verificationStartedAt);
  const delayed = applyEpicVerificationResult(current.epic, verificationResultFor(old.run));
  replace([snapshot(delayed, progress(delayed))]);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(current.run.id);
    expect(app.lastFrame()).toContain(old.run.id);
    expect(app.lastFrame()).toMatch(/stale|古い/iu);
    expect(currentEvidenceRow(app)).not.toContain(old.run.id);
    expect(currentEvidenceRow(app)).not.toContain(started.run.id);
  });
  const successful = applyEpicVerificationResult(delayed, verificationResultFor(current.run));
  replace([snapshot(successful, progress(successful))]);
  await waitFor(() => expect(currentEvidenceRow(app)).toContain(current.run.id));
});

it('displays a restored running verification as recovery work without submitting a command or changing its snapshot', async () => {
  const started = beginEpicVerification(memberEpic(), verificationRunId, verificationStartedAt);
  const item = snapshot(started.epic, progress(started.epic));
  const before = structuredClone(item);
  const { app, replace, client } = mountEpics([item], 'en');
  await openDetail(app, started.epic);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(started.run.id);
    expect(app.lastFrame()).toMatch(/recover|confirm.*result|result.*confirm/iu);
  });
  expect(currentEvidenceRow(app)).not.toContain(started.run.id);
  replace([structuredClone(item)]);
  await waitFor(() => expect(app.lastFrame()).toContain(started.run.id));
  expect(client.submit).not.toHaveBeenCalled();
  expect(client.getSnapshot().items.filter((value) => value.kind === 'epic')).toEqual([before]);
});

it('preserves the draft and active turn while Epic navigation switches to goal and question menus', async () => {
  const epic = memberEpic();
  const { app, client } = mountEpics([snapshot(epic, progress(epic))], 'en');
  const goal = { ...goalRecord(), repositoryDirectory: cwd, awaitingHumanMerge: false };
  client.change({ items: [...client.getSnapshot().items, { kind: 'goal', goal }] });
  await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', 'en')));
  app.stdin.write('Unsent conversation draft');
  await waitFor(() => expect(app.lastFrame()).toContain('Unsent conversation draft'));
  const operationId = randomUUID();
  client.change({ state: { ...client.getSnapshot().state!, running: { kind: 'turn', operationId, generation: 1 } } });
  client.output({ kind: 'activity', operationId, generation: 1, activity: { kind: 'tool', tool: 'Read', description: 'Inspect member goals' } });
  await openDetail(app, epic);
  app.stdin.write(ESC);
  await waitFor(() => expect(app.lastFrame()).not.toContain(epic.targets[0]!.targetSha));
  expect(client.submit).not.toHaveBeenCalled();
  app.stdin.write(GOAL_MENU);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en'));
    expect(app.lastFrame()).not.toContain(epic.objective);
  });
  app.stdin.write(ESC);
  await waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.goal', 'en')));
  await openList(app, epic.objective);
  app.stdin.write(QUESTION_MENU);
  await waitFor(() => {
    expect(app.lastFrame()).not.toContain(epic.objective);
    expect(app.lastFrame()).toContain(getLabel('manager.selectionEmpty.answer', 'en'));
    expect(app.lastFrame()).toContain('Inspect member goals');
  });
  client.change({ state: { ...client.getSnapshot().state!, running: null } });
  app.stdin.write(ENTER);
  await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'Unsent conversation draft' }]));
});

it('shows an empty list and then a newly created Epic on the same screen', async () => {
  const { app, replace, client } = mountEpics([], 'en');
  await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', 'en')));
  app.stdin.write(EPIC_MENU);
  await waitFor(() => expect(app.lastFrame()).toMatch(/no epics|epic.*empty/iu));
  const epic = memberEpic();
  replace([snapshot(epic, progress(epic))]);
  await waitFor(() => expect(app.lastFrame()).toContain(epic.objective));
  expect(app.lastFrame()!.split(epic.objective)).toHaveLength(2);
  expect(client.submit).not.toHaveBeenCalled();
});

describe.each(['list', 'detail'] as const)('delayed goal abort results during Epic %s browsing', (view) => {
  it.each(['notice', 'retry', 'cancel', 'escape'] as const)('keeps browsing and handles the deferred %s result on exit', async (action) => {
    const epic = memberEpic();
    const { app, client } = mountEpics([snapshot(epic, progress(epic))], 'en');
    const goal = { ...goalRecord(), repositoryDirectory: cwd, awaitingHumanMerge: false };
    client.change({ items: [...client.getSnapshot().items, { kind: 'goal', goal }] });
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', 'en')));
    app.stdin.write(GOAL_MENU);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en')));
    app.stdin.write(ENTER);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.goalActions.abort', 'en')));
    app.stdin.write(DOWN); app.stdin.write(ENTER);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
    app.stdin.write(UP); app.stdin.write(ENTER);
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'abort_goal', goalId: goal.id }]));
    const operationId = await client.operation();
    await waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en')));
    if (view === 'detail') await openDetail(app, epic);
    else await openList(app, epic.objective);
    const message = 'Pending task invalidation result';
    client.output({ kind: 'result', operationId, result: action === 'notice'
      ? { kind: 'notice', message }
      : { kind: 'error', code: 'operation_failed', message } });
    await waitFor(() => {
      expect(app.lastFrame()).toContain(message);
      expect(app.lastFrame()).toContain(getLabel(`manager.epics.${view}Title`, 'en'));
      expect(app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
    });
    app.stdin.write(DOWN); app.stdin.write(ENTER);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.epics.detailTitle', 'en')));
    expect(client.commands()).toHaveLength(1);
    app.stdin.write(ESC);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.epics.listTitle', 'en')));
    // Reopening the list must not discard a delayed retry target.
    app.stdin.write(EPIC_MENU);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.epics.listTitle', 'en')));
    app.stdin.write(ESC);
    if (action === 'notice') {
      await waitFor(() => expect(app.lastFrame()).not.toContain(epic.objective));
      expect(app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
    } else {
      await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.retryAbort', 'en')));
      if (action === 'retry') {
        app.stdin.write(UP); app.stdin.write(ENTER);
        await waitFor(() => expect(client.commands()).toEqual([
          { kind: 'abort_goal', goalId: goal.id }, { kind: 'abort_goal', goalId: goal.id },
        ]));
        client.output({ kind: 'result', operationId: await client.operation(), result: { kind: 'notice', message: 'Retry completed' } });
      } else app.stdin.write(action === 'cancel' ? ENTER : ESC);
      await waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en')));
      expect(client.commands()).toHaveLength(action === 'retry' ? 2 : 1);
    }
    await openList(app, epic.objective);
    expect(app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
  });
});

it('updates the verification and invalidation summary while the same list stays open', async () => {
  const started = beginEpicVerification(memberEpic(), verificationRunId, verificationStartedAt);
  const verified = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
  const { app, replace } = mountEpics([snapshot(verified, progress(verified))], 'en');
  await openList(app, verified.objective);
  expect(currentEvidenceRow(app)).toContain(started.run.id);
  const reason = 'Recheck the changed integration criteria';
  const revised = reviseEpic(verified, { acceptanceCriteria: [{ id: 'updated', description: 'Check the corrected integration' }] },
    { kind: 'definition', reason, recordedAt: verificationStartedAt });
  replace([snapshot(revised, progress(revised))]);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(reason);
    expect(currentEvidenceRow(app).split('|')[0]).not.toContain(started.run.id);
  });
});

it('navigates beyond the first list page and never substitutes another Epic when the open detail disappears', async () => {
  const epics = Array.from({ length: 12 }, (_, index): Epic => ({ ...memberEpic(),
    id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, objective: `Epic page ${index}` }));
  const { app, replace } = mountEpics(epics.map((epic) => snapshot(epic, progress(epic))), 'en');
  await openList(app, epics[0]!.objective);
  for (let index = 0; index < 10; index++) app.stdin.write(DOWN);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(epics[10]!.objective);
    expect(app.lastFrame()).not.toContain(epics[0]!.objective);
  });
  app.stdin.write(ENTER);
  await waitFor(() => expect(app.lastFrame()).toContain(epics[10]!.id));
  replace([snapshot(epics[0]!, progress(epics[0]!))]);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.epics.unavailable', 'en'));
    expect(app.lastFrame()).not.toContain(epics[0]!.targets[0]!.targetSha);
  });
  app.stdin.write(ESC);
  await waitFor(() => expect(app.lastFrame()).toContain(epics[0]!.objective));
});

it('scrolls the detail to the end and back without editing or sending the conversation draft', async () => {
  const epic = { ...memberEpic(), verificationProcedure: { version: 1, steps: Array.from({ length: 40 }, (_, index) => `Verification step ${index}`) } };
  const { app, client } = mountEpics([snapshot(epic, progress(epic))], 'en');
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 24 });
  app.stdout.emit('resize');
  await openDetail(app, epic);
  expect(app.lastFrame()).not.toContain('Verification step 39');
  app.stdin.write('\x1b[F');
  await waitFor(() => expect(app.lastFrame()).toContain('Verification step 39'));
  app.stdin.write('\x1b[H');
  await waitFor(() => expect(currentEvidenceRow(app)).toContain(getLabel('manager.epics.none', 'en')));
  expect(client.submit).not.toHaveBeenCalled();
});

it('formats complete evidence at a narrow width while removing terminal controls and sensitive values', () => {
  const started = beginEpicVerification(memberEpic(), verificationRunId, verificationStartedAt);
  const verified = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
  const item = snapshot({ ...verified, objective: '\x1b[31mAPI\x1b[0m と画面 sk-abcdefgh1234' }, progress(verified));
  const lines = formatManagerEpicDetail(item, 'ja', 24);
  const text = lines.join('');
  expect(text).toContain('[REDACTED]');
  expect(text).not.toContain('sk-abcdefgh1234');
  expect(text).not.toContain('\x1b');
  expect(text).toContain(started.run.id);
  expect(text).toContain('artifact://integration/build-1');
  for (const line of lines) expect(measureWidth(line)).toBeLessThanOrEqual(24);
});
