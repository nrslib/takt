import { beforeEach, expect, it, vi } from 'vitest';
import { GoalPullRequestUnavailableError, prepareGoalPullRequest } from '../infra/goals/pull-request.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';

const doubles = vi.hoisted(() => ({ providerType: vi.fn(), detected: vi.fn(), git: vi.fn(), find: vi.fn(), create: vi.fn(), details: vi.fn(), command: vi.fn() }));
vi.mock('../infra/github/pr-command.js', () => ({ runPrCommand: doubles.command }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: doubles.providerType }));
vi.mock('../infra/git/detect.js', () => ({ detectVcsProvider: doubles.detected }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git }));
vi.mock('../infra/github/GitHubProvider.js', () => ({ GitHubProvider: class {
  findExistingPr = doubles.find;
  createPullRequest = doubles.create;
  fetchPrDetails = doubles.details;
} }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string, language: 'ja' | 'en') => {
  const labels = { ja: ['目的', '変更', '確かめたこと', '人が確かめる手順'],
    en: ['Objective', 'Changes', 'Verification', 'Human verification steps'] };
  const index = ['objective', 'changes', 'verification', 'humanChecks'].indexOf(key.replace('manager.goalPr.', ''));
  return index < 0 ? `${language}:${key}` : labels[language][index];
} }));

let goal: Goal = goalRecord();
const sha = 'a'.repeat(40);
const completion = {
  goalBranch: goal.branch, goalSha: sha, targetBranch: 'main', summary: 'Test evidence', instructions: [],
  changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [{ path: 'result.ts', additions: 1, deletions: 0 }],
    truncated: false, totalsTruncated: false },
};
const pr = { number: 1950, url: 'https://github.com/example/project/pull/1950' };
const prDetails = { number: pr.number, headBranch: goal.branch, headSha: sha, baseBranch: 'main', sameRepository: true,
  headRepositoryUrl: 'https://github.com/example/project.git', headRepositoryPushUrls: ['https://github.com/example/project.git'] };
const assertCurrent = vi.fn<() => Promise<void>>();
const signal = new AbortController().signal;
const taktStart = '<!-- takt:goal-pr:start -->';
const taktEnd = '<!-- takt:goal-pr:end -->';
const releaseNotesStart = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
const releaseNotesEnd = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';
const releaseNotes = [releaseNotesStart, '<!-- coderabbit-ai-generated:v1 -->', '',
  '## Summary by CodeRabbit', '', '* 改善  ', '<details><summary>変更</summary>内容</details>', releaseNotesEnd].join('\r\n');

function expectedBody(language: 'ja' | 'en', summary = completion.summary, checks = 'Check the result') {
  const headings = language === 'ja' ? ['目的', '変更', '確かめたこと', '人が確かめる手順']
    : ['Objective', 'Changes', 'Verification', 'Human verification steps'];
  return [taktStart, `## ${headings[0]}`, goal.objective, `## ${headings[1]}`, '- result.ts',
    `## ${headings[2]}`, summary, `## ${headings[3]}`, checks, taktEnd].join('\n\n');
}

function serveBody(body: string) {
  doubles.command.mockImplementation(async (args: string[], cwd: string) => {
    expect(cwd).toBe('/project');
    if (args[1] === 'view') return JSON.stringify({ body });
    if (args[1] === 'edit') return '';
    throw new Error(`Unexpected PR command: ${args.join(' ')}`);
  });
}

function editedBody() {
  const edits = doubles.command.mock.calls.filter(([args]) => args[1] === 'edit');
  expect(edits).toHaveLength(1);
  const args = edits[0]![0] as string[];
  expect(args.slice(0, 4)).toEqual(['pr', 'edit', pr.url, '--body']);
  expect(args).toHaveLength(5);
  return args[4]!;
}

beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  assertCurrent.mockResolvedValue(undefined);
  doubles.providerType.mockReturnValue('github');
  doubles.git.mockResolvedValue({ output: Buffer.alloc(0), code: 0, truncated: false });
  doubles.create.mockReturnValue({ success: true, url: pr.url });
  doubles.details.mockResolvedValue(prDetails);
  serveBody(expectedBody('ja', 'Old evidence', 'Old checks'));
});

it.each(['ja', 'en'] as const)('publishes the reviewed SHA before creating the PR with %s review information', async (language) => {
  doubles.create.mockImplementation((options) => {
    expect(doubles.git).toHaveBeenNthCalledWith(2, '/project',
      ['push', '--', 'origin', `${sha}:refs/heads/${goal.branch}`], 4096, signal);
    expect(options).toMatchObject({ branch: goal.branch, base: 'main' });
    expect(options).toMatchObject({ title: goal.objective, body: expectedBody(language, completion.summary, 'Open the result') });
    return { success: true, url: pr.url };
  });
  expect(await prepareGoalPullRequest('/project', goal, completion, 'Open the result', language, signal, assertCurrent)).toEqual(pr);
  expect(doubles.command).not.toHaveBeenCalled();
});

it('updates the existing matching PR with the complete new body without creating another', async () => {
  doubles.find.mockReturnValue(pr);
  expect(await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'ja', signal, assertCurrent)).toEqual(pr);
  expect(doubles.details).toHaveBeenCalledExactlyOnceWith(1950, '/project', signal);
  expect(doubles.create).not.toHaveBeenCalled();
  expect(doubles.command).toHaveBeenNthCalledWith(1, ['pr', 'view', pr.url, '--json', 'body'], '/project', expect.objectContaining({ signal }));
  expect(editedBody()).toBe(expectedBody('ja'));
  expect(doubles.command.mock.calls[1]![2]).toEqual(expect.objectContaining({ signal }));
});

it.each(['ja', 'en'] as const)('replaces only marked %s content and preserves human additions and CodeRabbit verbatim', async (language) => {
  doubles.find.mockReturnValue(pr);
  const prefix = '## 運用メモ\r\n\r\n公開は金曜日  \r\n\r\n';
  const suffix = `\n\n${releaseNotes}\n\nKeep this paragraph.  `;
  serveBody(prefix + expectedBody(language, 'Old evidence', 'Old checks') + suffix);
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', language, signal, assertCurrent);
  expect(editedBody()).toBe(prefix + expectedBody(language) + suffix);
});

it.each([false, true])('replaces unmarked content while preserving CodeRabbit (release notes: %s)', async (withNotes) => {
  doubles.find.mockReturnValue(pr);
  const legacy = '## 目的\n\nOld objective\n\n## 確かめたこと\n\nFirst evidence\n\n- Unit tests passed';
  serveBody(legacy + (withNotes ? `\n\n${releaseNotes}` : ''));
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'ja', signal, assertCurrent);
  expect(editedBody()).toBe(expectedBody('ja') + (withNotes ? `\n\n${releaseNotes}` : ''));
});

it('preserves multiple legacy CodeRabbit blocks in their original order and exact formatting', async () => {
  doubles.find.mockReturnValue(pr);
  const second = `${releaseNotesStart}\n* Second summary  \n${releaseNotesEnd}`;
  serveBody(`${releaseNotes}\n\nOld content\n\n${second}\n\nMore old content`);
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'en', signal, assertCurrent);
  expect(editedBody()).toBe(`${expectedBody('en')}\n\n${releaseNotes}\n\n${second}`);
});

it('updates all content inside the TAKT markers without reconstructing previous completion', async () => {
  doubles.find.mockReturnValue(pr);
  serveBody([taktStart, 'Different headings\n\n- Added item\n\nMultiple paragraphs', taktEnd].join('\n\n'));
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'ja', signal, assertCurrent);
  expect(editedBody()).toBe(expectedBody('ja'));
});

it('replaces the previously updated body on a second submission without duplicating release notes', async () => {
  doubles.find.mockReturnValue(pr);
  serveBody(`Old content\n\n${releaseNotes}`);
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'ja', signal, assertCurrent);
  const first = editedBody();
  doubles.command.mockClear();
  serveBody(first);
  await prepareGoalPullRequest('/project', goal, { ...completion, summary: 'Additional tests passed' }, 'Open the new result', 'ja', signal, assertCurrent);
  expect(editedBody()).toBe(`${expectedBody('ja', 'Additional tests passed', 'Open the new result')}\n\n${releaseNotes}`);
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each(['objective', 'path', 'summary', 'humanChecks'] as const)(
  'escapes input markers in %s and updates the same published body again', async (field) => {
    const input = `Before ${taktStart} middle ${taktEnd} after ${taktStart}`;
    const nextGoal = field === 'objective' ? { ...goal, objective: input } : goal;
    const nextCompletion = { ...completion,
      summary: field === 'summary' ? input : completion.summary,
      changeSummary: { ...completion.changeSummary,
        files: [{ ...completion.changeSummary.files[0]!, path: field === 'path' ? input : 'result.ts' }] },
    };
    const checks = field === 'humanChecks' ? input : 'Check the result';
    await prepareGoalPullRequest('/project', nextGoal, nextCompletion, checks, 'en', signal, assertCurrent);
    const published = doubles.create.mock.calls[0]![0].body as string;
    expect(published.split(taktStart)).toHaveLength(2);
    expect(published.split(taktEnd)).toHaveLength(2);
    expect(published).toContain(input.replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    doubles.find.mockReturnValue(pr);
    serveBody(`${published}\n\n${releaseNotes}`);
    await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'en', signal, assertCurrent);
    const updated = editedBody();
    expect(updated).toBe(`${expectedBody('en')}\n\n${releaseNotes}`);
    doubles.command.mockClear();
    serveBody(updated);
    await prepareGoalPullRequest('/project', goal, { ...completion, summary: 'Final evidence' }, 'Final checks', 'en', signal, assertCurrent);
    expect(editedBody()).toBe(`${expectedBody('en', 'Final evidence', 'Final checks')}\n\n${releaseNotes}`);
  },
);

it.each([
  `${taktStart}\n${releaseNotes}\n${taktEnd}`,
  `${releaseNotesStart}\n${taktStart}\nOld\n${taktEnd}\n${releaseNotesEnd}`,
  `${taktStart}\nOld\n${releaseNotesStart}\n${taktEnd}\nSummary\n${releaseNotesEnd}`,
  `${releaseNotesStart}\nSummary\n${taktStart}\n${releaseNotesEnd}\nOld\n${taktEnd}`,
])('rejects overlapping TAKT and CodeRabbit sections without editing: %s', async (body) => {
  doubles.find.mockReturnValue(pr);
  serveBody(body);
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent))
    .rejects.toMatchObject({ operation: 'body' });
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each([true, false])('preserves directly adjacent CodeRabbit notes before TAKT: %s', async (before) => {
  doubles.find.mockReturnValue(pr);
  const old = expectedBody('en', 'Old evidence', 'Old checks');
  serveBody(before ? releaseNotes + old : old + releaseNotes);
  await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'en', signal, assertCurrent);
  expect(editedBody()).toBe(before ? releaseNotes + expectedBody('en') : expectedBody('en') + releaseNotes);
});

it.each(['read', 'edit', 'edit applied'] as const)('retries a multiline body after %s fails without local publication state', async (operation) => {
  doubles.find.mockReturnValue(pr);
  let remoteBody = expectedBody('en', 'First evidence\n\n- Unit tests passed', 'First step\n\nSecond step');
  let failed = true;
  doubles.command.mockImplementation(async (args: string[]) => {
    if (args[1] === 'view') {
      if (failed && operation === 'read') throw new Error('read failed');
      return JSON.stringify({ body: remoteBody });
    }
    if (!failed || operation === 'edit applied') remoteBody = args[4]!;
    if (failed) throw new Error('edit failed');
    return '';
  });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Additional checks', 'en', signal, assertCurrent))
    .rejects.toMatchObject({ operation: 'body' });
  failed = false;
  await prepareGoalPullRequest('/project', goal, { ...completion, summary: 'Final evidence' }, 'Final checks', 'en', signal, assertCurrent);
  expect(remoteBody).toBe(expectedBody('en', 'Final evidence', 'Final checks'));
});

it('updates changed files and truncation information using the current completion', async () => {
  doubles.find.mockReturnValue(pr);
  const next = { ...completion, summary: 'New evidence', changeSummary: { ...completion.changeSummary,
    filesChanged: 2, files: [{ path: 'new-file.ts', additions: 1, deletions: 0 }], truncated: true } };
  await prepareGoalPullRequest('/project', goal, next, 'New checks', 'en', signal, assertCurrent);
  expect(editedBody()).toBe([taktStart, '## Objective', goal.objective,
    '## Changes', '- new-file.ts', 'en:manager.goalPr.truncated',
    '## Verification', 'New evidence', '## Human verification steps', 'New checks', taktEnd].join('\n\n'));
});

it.each([taktStart, taktEnd, `${taktEnd}\n${taktStart}`, `${taktStart}\n${taktStart}\n${taktEnd}`,
  `${taktStart}\n${taktEnd}\n${taktEnd}`])('rejects incomplete or duplicated TAKT markers without editing: %s', async (body) => {
  doubles.find.mockReturnValue(pr);
  serveBody(body);
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent))
    .rejects.toMatchObject({ operation: 'body' });
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
});

it.each(['read', 'edit'] as const)('reports a PR body %s failure instead of returning or creating a PR', async (operation) => {
  doubles.find.mockReturnValue(pr);
  if (operation === 'read') doubles.command.mockRejectedValueOnce(new Error('body read failed'));
  else doubles.command.mockResolvedValueOnce(JSON.stringify({ body: expectedBody('en', 'Old evidence', 'Old checks') })).mockRejectedValueOnce(new Error('body edit failed'));
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent))
    .rejects.toBeInstanceOf(GoalPullRequestUnavailableError);
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toHaveLength(operation === 'read' ? 0 : 1);
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each(['invalid JSON', '{}', '{"body":null}', '{"body":42}'])('rejects an unreadable body response without editing: %s', async (response) => {
  doubles.find.mockReturnValue(pr);
  doubles.command.mockResolvedValueOnce(response);
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent))
    .rejects.toBeInstanceOf(GoalPullRequestUnavailableError);
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each([releaseNotesStart, releaseNotesEnd, `${releaseNotesStart}\n${releaseNotesStart}\n${releaseNotesEnd}`])(
  'leaves an ambiguous CodeRabbit release note block untouched: %s', async (body) => {
    doubles.find.mockReturnValue(pr);
    serveBody(body);
    await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toThrow();
    expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
    expect(doubles.create).not.toHaveBeenCalled();
  },
);

it('does not edit when the goal changes while its existing body is being read', async () => {
  doubles.find.mockReturnValue(pr);
  const changed = new Error('Goal changed during body lookup');
  doubles.command.mockImplementationOnce(async () => {
    assertCurrent.mockRejectedValue(changed);
    return JSON.stringify({ body: expectedBody('en', 'Old evidence', 'Old checks') });
  });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toBe(changed);
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
});

it.each(['read', 'edit'] as const)('propagates cancellation during body %s without treating it as PR unavailability', async (operation) => {
  doubles.find.mockReturnValue(pr);
  const controller = new AbortController();
  if (operation === 'edit') doubles.command.mockResolvedValueOnce(JSON.stringify({ body: expectedBody('en', 'Old evidence', 'Old checks') }));
  doubles.command.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('Cancelled PR body command');
  });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', controller.signal, assertCurrent))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toHaveLength(operation === 'read' ? 0 : 1);
  expect(doubles.create).not.toHaveBeenCalled();
});

it('does not edit if cancellation arrives with a successful body response', async () => {
  doubles.find.mockReturnValue(pr);
  const controller = new AbortController();
  doubles.command.mockImplementationOnce(async () => {
    controller.abort();
    return JSON.stringify({ body: releaseNotes });
  });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', controller.signal, assertCurrent))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(doubles.command.mock.calls.filter(([args]) => args[1] === 'edit')).toEqual([]);
});

it.each([
  { headBranch: 'other', baseBranch: 'main', sameRepository: true },
  { headBranch: goal.branch, baseBranch: 'release', sameRepository: true },
  { headBranch: goal.branch, baseBranch: 'main', sameRepository: false },
])('rejects an existing PR for another target: %j', async (details) => {
  doubles.find.mockReturnValue(pr); doubles.details.mockResolvedValue({ ...prDetails, ...details });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toThrow();
  expect(doubles.create).not.toHaveBeenCalled();
  expect(doubles.command).not.toHaveBeenCalled();
});

it.each([undefined, '', ' \n '])('rejects missing verification steps before publishing: %s', async (checks) => {
  await expect(prepareGoalPullRequest('/project', goal, completion, checks, 'en', signal, assertCurrent)).rejects.toThrow();
  expect(doubles.git).toHaveBeenCalledExactlyOnceWith('/project', ['remote', 'get-url', 'origin'], 4096, signal);
  expect(doubles.create).not.toHaveBeenCalled();
});

it('classifies push failure as unavailable without creating a PR', async () => {
  doubles.git.mockResolvedValueOnce({ output: Buffer.from('origin'), code: 0, truncated: false }).mockRejectedValueOnce(new Error('push failed'));
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toBeInstanceOf(GoalPullRequestUnavailableError);
  expect(doubles.find).not.toHaveBeenCalled(); expect(doubles.create).not.toHaveBeenCalled();
});

it.each([{ success: false, error: 'failure' }, { success: true }, { success: true, url: 'invalid' }])(
  'rejects failed or incomplete creation results: %j', async (result) => {
    doubles.create.mockReturnValue(result);
    await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toThrow();
  },
);

it.each([
  { configured: undefined, detected: undefined },
  { configured: undefined, detected: 'gitlab' },
  { configured: 'gitlab', detected: 'github' },
])('skips unsupported PR environments: %j', async ({ configured, detected }) => {
  doubles.providerType.mockReturnValue(configured);
  doubles.detected.mockReturnValue(detected);
  await expect(prepareGoalPullRequest('/project', goal, completion, undefined, 'en', signal, assertCurrent))
    .rejects.toBeInstanceOf(GoalPullRequestUnavailableError);
  expect(doubles.git).not.toHaveBeenCalled();
  expect(doubles.find).not.toHaveBeenCalled();
  expect(doubles.create).not.toHaveBeenCalled();
});

it('does not treat cancellation during push as PR unavailability', async () => {
  const controller = new AbortController();
  doubles.git.mockResolvedValueOnce({ output: Buffer.from('origin'), code: 0, truncated: false })
    .mockImplementationOnce(async () => { controller.abort(); throw new Error('push cancelled'); });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', controller.signal, assertCurrent))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(doubles.create).not.toHaveBeenCalled();
});

it('classifies a missing origin before requiring PR review steps', async () => {
  doubles.git.mockRejectedValueOnce(new Error('No such remote: origin'));
  await expect(prepareGoalPullRequest('/project', goal, completion, undefined, 'en', signal, assertCurrent))
    .rejects.toBeInstanceOf(GoalPullRequestUnavailableError);
  expect(doubles.git).toHaveBeenCalledExactlyOnceWith('/project', ['remote', 'get-url', 'origin'], 4096, signal);
  expect(doubles.create).not.toHaveBeenCalled();
});

it('does not create a PR if the goal pauses or its tip changes while push is running', async () => {
  assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Goal changed'));
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal, assertCurrent)).rejects.toThrow();
  expect(doubles.git).toHaveBeenCalledTimes(2);
  expect(doubles.find).not.toHaveBeenCalled();
  expect(doubles.create).not.toHaveBeenCalled();
});
