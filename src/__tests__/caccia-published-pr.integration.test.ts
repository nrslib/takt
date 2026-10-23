import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

vi.mock('../features/pipeline/steps.js', () => ({
  resolveTaskContent: () => ({ task: 'Publish development' }),
  resolveExecutionContext: (cwd: string) => ({ execCwd: cwd, branch: 'feature/pr', baseBranch: 'main', isWorktree: false }),
  runWorkflow: vi.fn().mockResolvedValue({ success: true, workflowHasCaccia: false }),
  commitAndPush: vi.fn().mockResolvedValue(true), buildCommitMessage: () => 'Development',
}));
vi.mock('../infra/task/index.js', async (original) => ({
  ...await original<typeof import('../infra/task/index.js')>(),
  autoCommitAndPush: vi.fn().mockResolvedValue({ success: true, commitHash: 'development-commit' }),
}));
vi.mock('../infra/task/git.js', async (original) => ({
  ...await original<typeof import('../infra/task/git.js')>(), pushBranch: vi.fn(),
}));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: vi.fn() }));
vi.mock('../shared/utils/index.js', async (original) => ({
  ...await original<typeof import('../shared/utils/index.js')>(), getSlackWebhookUrl: () => undefined,
}));

import { executePipeline } from '../features/pipeline/execute.js';
import { runWorkflow, commitAndPush } from '../features/pipeline/steps.js';
import { autoCommitAndPush } from '../infra/task/index.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { initGitProvider } from '../infra/git/index.js';
import { TaskRunner } from '../infra/task/index.js';
import { executePersistedPrMergeTask } from '../features/merge/index.js';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';

const fakeGh = `#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const path = process.env.TAKT_TEST_PUBLISHED_PR_STATE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(state.log, JSON.stringify(args) + String.fromCharCode(10));
const send = value => console.log(JSON.stringify(value));
const save = () => fs.writeFileSync(path, JSON.stringify(state));
if (args[0] === 'auth' || args[0] === '--version') process.exit(0);
if (args[0] === 'pr' && args[1] === 'create') {
  console.log(state.url); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  send(state.existing ? [{number:123,url:state.url}] : []); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  if (args.includes('@coderabbitai review')) state.requested = true;
  save(); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  state.merged = true; save(); process.exit(0);
}
const repo = args[0] === 'pr'
  ? (args[2] === state.url ? state.repo : 'source')
  : (args.find(arg => arg.startsWith('repo='))?.slice(5) ?? state.repo);
const head = execFileSync('git', ['--git-dir',state.remotes[repo], 'rev-parse','refs/heads/feature/pr'], {encoding:'utf8'}).trim();
if (args[0] === 'pr' && args[1] === 'view') {
  if (state.failTarget && args[2] === state.url) process.exit(1);
  const fields = args[args.indexOf('--json')+1];
  if (fields.includes('statusCheckRollup') && state.failStatusOnce) {
    state.failStatusOnce = false; save(); process.exit(1);
  }
  if (fields === 'url,headRefOid') { state.headReads = (state.headReads ?? 0)+1; save(); }
  const url = state.mismatch || (state.effectMismatch && state.headReads >= 3 && fields === 'url,headRefOid')
    ? state.sourceUrl : (args[2] === state.url ? state.url : state.sourceUrl);
  if (fields.includes('statusCheckRollup')) send({number:123,url,headRefOid:head,state:state.merged?'MERGED':'OPEN',
    mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[
      {__typename:'StatusContext',context:'test',state:'SUCCESS'}]});
  else if (fields.includes('baseRefName') && !fields.includes('title')) send({url,baseRefName:'main',isCrossRepository:false});
  else if (fields.includes('title')) send({number:123,url,title:'Published PR',body:'Review this PR',
    headRefName:'feature/pr',baseRefName:'main',comments:[],reviews:[],files:[{path:'README.md'}]});
  else send({url,headRefOid:head});
  process.exit(0);
}
const query = args.find(arg => arg.startsWith('query=')) ?? '';
const page = nodes => ({pageInfo:{hasNextPage:false,endCursor:null},nodes});
if (args[1]?.startsWith('repos/')) {
  send({statuses:[]});
} else if (query.includes('resolveReviewThread')) {
  const id = args.find(arg => arg.startsWith('threadId=')).slice(9);
  state.resolved.push(id); save(); send({data:{resolveReviewThread:{thread:{id,isResolved:true}}}});
} else if (query.includes('headRepository {')) {
  send({data:{repository:{pullRequest:{number:123,headRefName:'feature/pr',headRefOid:head,
    headRepository:{sshUrl:'git@'+state.hostname+':acme/'+repo+'.git'}}}}});
} else {
  let data;
  if (query.includes('reviews(')) data = {reviews:page(state.rateLimited && !state.requested ? []
    : [{author:{login:'coderabbitai'},state:'COMMENTED',submittedAt:'2026-10-23T00:00:00Z',commit:{oid:head}}])};
  else if (query.includes('reviewThreads(')) {
    const detailed = query.includes('isResolved');
    const nodes = state.resolved.includes('thread-'+repo) ? [] : [{id:'thread-'+repo,isResolved:false,isOutdated:false,
      comments:page([{author:{login:'coderabbitai'},body:'Fix the published repository',path:'README.md',line:1,
        url:state.url+'#discussion_r1'}])}];
    data = {headRefOid:head,reviewThreads:page(detailed ? nodes : [])};
  } else data = {comments:page(state.rateLimited && !state.requested ? [{author:{login:'coderabbitai'},
    updatedAt:new Date(Date.now()-1000).toISOString(),
    body:'<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->'+String.fromCharCode(10)
      +'> ## Rate limit exceeded'+String.fromCharCode(10)+'between '+head+' and '+head+String.fromCharCode(10)
      +'**Next review available in:** **0 seconds**'+String.fromCharCode(10)
      +'<!-- end of auto-generated comment: rate limited by coderabbit.ai -->'}] : [])};
  send({data:{repository:{pullRequest:data}}});
}
`;

describe('Published PR identity through production Caccia', () => {
  let root: string;
  let project: string;
  let statePath: string;
  let remotes: Record<string, string>;
  let clonePaths: string[];
  let mergeStarts: string[];
  let fixStarted: (() => void) | undefined;
  let finishFix: Promise<void> | undefined;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  beforeEach(() => {
    vi.mocked(runWorkflow).mockResolvedValue({ success: true, workflowHasCaccia: false });
    vi.mocked(commitAndPush).mockResolvedValue(true);
    vi.mocked(autoCommitAndPush).mockResolvedValue({ success: true, commitHash: 'development-commit', message: 'Committed' });
    root = mkdtempSync(join(tmpdir(), 'takt-published-caccia-'));
    project = join(root, 'project'); statePath = join(root, 'state.json'); remotes = {}; clonePaths = []; mergeStarts = [];
    fixStarted = undefined; finishFix = undefined;
    vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'config'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    writeFileSync(join(root, 'gitconfig'), '[user]\n name = Caccia Test\n email = caccia@example.test\n');
    for (const repo of ['source', 'target']) {
      remotes[repo] = join(root, repo + '.git');
      git(root, 'init', '--bare', remotes[repo]!);
      const author = join(root, repo + '-author');
      git(root, 'init', '--initial-branch=main', author);
      writeFileSync(join(author, 'README.md'), repo + '\n');
      writeFileSync(join(author, '.gitignore'), '.takt/\n');
      git(author, 'add', '.'); git(author, 'commit', '-m', repo);
      git(author, 'push', remotes[repo]!, 'HEAD:refs/heads/feature/pr');
      git(author, 'push', remotes[repo]!, 'HEAD:refs/heads/main');
    }
    git(root, 'clone', '--branch', 'feature/pr', remotes.source!, project);
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), fakeGh, { mode: 0o755 });
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    vi.stubEnv('TAKT_TEST_PUBLISHED_PR_STATE', statePath);
    vi.mocked(runWorkflowExecution).mockReset().mockImplementation(async (request, context) => {
      if (request.cacciaExecutionSource === 'merge') {
        mergeStarts.push(request.cwd);
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { repo: string };
        expect(git(request.cwd, 'config', '--get', 'remote.origin.url')).toBe(request.prExecutionContext!.headRepositoryUrl);
        expect(git(request.cwd, 'config', '--get', 'remote.base.url')).toBe(request.prExecutionContext!.headRepositoryUrl);
        expect(git(request.cwd, 'rev-parse', request.prContext!.baseDiffRef!))
          .toBe(git(root, '--git-dir', remotes[state.repo]!, 'rev-parse', 'refs/heads/main'));
        const actual = await vi.importActual<typeof import('../features/tasks/execute/workflowExecutionApi.js')>(
          '../features/tasks/execute/workflowExecutionApi.js');
        return actual.runWorkflowExecution({ ...request, agentOverrides: { provider: 'mock' }, outputMode: 'silent' }, context);
      }
      clonePaths.push(request.cwd);
      fixStarted?.();
      await finishFix;
      writeFileSync(join(request.cwd, 'fixed.txt'), 'published PR fix\n');
      const report = join(root, 'report'); mkdirSync(report, { recursive: true });
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { repo: string };
      writeFileSync(join(report, 'caccia-decisions.json'), JSON.stringify([
        { thread_id: 'thread-' + state.repo, valid: true, reason: 'Corrected' },
      ]));
      return { success: true, reportDirectory: report };
    });
  });

  afterEach(() => {
    for (const path of clonePaths) expect(existsSync(path)).toBe(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs(); invalidateAllResolvedConfigCache();
    resetScenario();
    rmSync(root, { recursive: true, force: true });
  });

  function configure(hostname: string, provider: 'github' | 'gitlab', repo: string, existing = false,
    failure?: 'failTarget' | 'mismatch') {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), stringify({ vcs_provider: provider,
      caccia: { enabled: true, wait_timeout_ms: 5000, max_iterations: 1 } }));
    invalidateAllResolvedConfigCache(); initGitProvider(project);
    const url = 'https://' + hostname + '/acme/' + repo + '/pull/123';
    const state = { hostname, url, sourceUrl: 'https://' + hostname + '/acme/source/pull/123',
      repo, remotes, existing, resolved: [], log: join(root, 'requests.jsonl'), [failure ?? 'none']: true };
    writeFileSync(statePath, JSON.stringify(state));
    for (const name of ['source', 'target']) {
      for (const prefix of ['https://' + hostname + '/acme/', 'git@' + hostname + ':acme/']) {
        git(root, 'config', '--file', join(root, 'gitconfig'), '--add', 'url.file://' + remotes[name] + '.insteadOf', prefix + name + '.git');
      }
    }
    git(project, 'remote', 'set-url', 'origin', 'https://' + hostname + '/acme/source.git');
    return url;
  }

  function requests(): string[][] {
    return readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
  }

  async function publish(entry: 'create' | 'update' | 'pipeline', repo: string) {
    if (entry === 'pipeline') return executePipeline({ cwd: project, task: 'Publish development', workflow: 'development',
      repo, autoPr: true, outputMode: 'silent' });
    return postExecutionFlow({ projectCwd: project, execCwd: project, task: 'Publish development', branch: 'feature/pr',
      shouldCreatePr: true, draftPr: false, repo, workflowHasCaccia: false, outputMode: 'silent' });
  }

  function configureMerge(effect: boolean, autoStart = true) {
    const workflow = join(project, '.takt', 'merge.yaml');
    writeFileSync(workflow, stringify({ name: 'published-merge', initial_step: 'inspect', max_steps: 5,
      steps: [{ name: 'inspect', instruction: 'type: caccia',
        rules: [{ condition: 'when(true)', next: 'review' }] },
      { name: 'review', kind: 'system', system_inputs: [
        { type: 'pr_status', source: 'current_pr', as: 'status' },
        { type: 'pr_context', source: 'current_branch', as: 'pull_request' },
      ], ...(effect ? { effects: [{ type: 'caccia', pr: 123 }] } : {}),
      rules: [...(effect ? [{ condition: 'when(effect.review.caccia.success == false)', next: 'ABORT' }] : []),
        { condition: 'when(true)', next: 'finish' }] },
      { name: 'finish', kind: 'system', effects: [
        { type: 'comment_pr', pr: 123, body: 'Reviewed published PR' },
        { type: 'merge_pr', pr: 123 },
      ], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] }));
    writeFileSync(join(project, '.takt', 'config.yaml'), stringify({ vcs_provider: 'github',
      caccia: { enabled: true, wait_timeout_ms: 5000, max_iterations: 1 },
      merge: { auto_start: autoStart, workflow } }));
    invalidateAllResolvedConfigCache();
    setMockScenario([{ status: 'done', content: 'Reviewed' }]);
  }

  const mergeCases = (['create', 'update', 'pipeline'] as const).flatMap((entry) =>
    (['github.com', 'ghe.example.test'] as const).flatMap((host) =>
      [true, false].map((effect) => ({ entry, host, effect }))));
  it.each(mergeCases)('$entry runs the published $host PR with merge effect=$effect', async ({ entry, host, effect }) => {
    const url = configure(host, 'github', 'target', entry === 'update');
    configureMerge(effect);
    const events = vi.spyOn(WorkflowEngine.prototype, 'emit');
    const sourceHead = git(root, '--git-dir', remotes.source!, 'rev-parse', 'refs/heads/feature/pr');
    let release!: () => void;
    const started = new Promise<void>((resolve) => { fixStarted = resolve; });
    finishFix = new Promise<void>((resolve) => { release = resolve; });
    const publishing = publish(entry, host + '/acme/target');
    await Promise.race([started, publishing.then(() => { throw new Error('Publication ended before Caccia fix started'); })]);
    expect(mergeStarts).toHaveLength(effect ? 1 : 0);
    release();
    await publishing;
    expect(mergeStarts, JSON.stringify(requests())).toHaveLength(1);
    expect(clonePaths).toHaveLength(1);
    expect(events.mock.calls.some(([event, step]) => event === 'step:start' && step.name === 'finish')).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual(['thread-target']);
    expect(requests().filter((args) => args[1] === 'view').every((args) => args[2] === url)).toBe(true);
    expect(requests().filter((args) => args[1] === 'merge')).toEqual([
      ['pr', 'merge', url, '--squash', '--delete-branch', '--match-head-commit',
        git(root, '--git-dir', remotes.target!, 'rev-parse', 'refs/heads/feature/pr')],
    ]);
    expect(requests().some((args) => args[1] === 'comment' && args[2] === url && args.includes('Reviewed published PR'))).toBe(true);
    for (const args of requests().filter((args) => args[0] === 'api')) expect(args.slice(-2)).toEqual(['--hostname', host]);
    expect(git(root, '--git-dir', remotes.source!, 'rev-parse', 'refs/heads/feature/pr')).toBe(sourceHead);
    expect(git(root, '--git-dir', remotes.target!, 'show', 'refs/heads/feature/pr:fixed.txt')).toBe('published PR fix');
    const saved = new TaskRunner(project).listAllTaskItems().find((task) => task.data?.merge_task);
    expect(saved).toMatchObject({ kind: 'completed', prUrl: url });
  });

  it('keeps post-PR Caccia when automatic merge is disabled despite the selected effect', async () => {
    configure('ghe.example.test', 'github', 'target');
    configureMerge(true, false);
    await publish('pipeline', 'ghe.example.test/acme/target');
    expect(mergeStarts).toEqual([]);
    expect(clonePaths).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual(['thread-target']);
  });

  it.each(['failTarget', 'mismatch', 'effectMismatch'] as const)('stops the automatic merge target after %s', async (failure) => {
    const url = configure('ghe.example.test', 'github', 'target');
    configureMerge(true);
    const before = Object.fromEntries(Object.entries(remotes).map(([name, path]) =>
      [name, git(root, '--git-dir', path, 'rev-parse', 'refs/heads/feature/pr')]));
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, [failure]: true }));
    await publish('pipeline', 'ghe.example.test/acme/target');
    expect(clonePaths).toEqual([]);
    expect(mergeStarts).toHaveLength(failure === 'effectMismatch' ? 1 : 0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual([]);
    expect(requests().filter((args) => args[1] === 'merge')).toEqual([]);
    expect(requests().filter((args) => args[1] === 'view').every((args) => args[2] === url)).toBe(true);
    for (const [name, path] of Object.entries(remotes)) {
      expect(git(root, '--git-dir', path, 'rev-parse', 'refs/heads/feature/pr')).toBe(before[name]);
    }
  });

  it.each([false, true])('restores the saved published target and rejects a mismatched response=%s', async (mismatch) => {
    const url = configure('ghe.example.test', 'github', 'target');
    configureMerge(true);
    const initialState = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...initialState, failStatusOnce: true }));
    await publish('pipeline', 'ghe.example.test/acme/target');
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.prUrl).toBe(url);
    expect(readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8')).toContain(url);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, mismatch }));
    runner.requeueTask(failed.name, ['failed']);
    const restoredRunner = new TaskRunner(project);
    const restored = restoredRunner.claimNextTasks(1)[0]!;
    expect(restored.prUrl).toBe(url);
    mergeStarts = [];
    setMockScenario([{ status: 'done', content: 'Reviewed' }]);
    const resumed = executePersistedPrMergeTask(restored, restoredRunner, project);
    if (mismatch) {
      await expect(resumed).rejects.toThrow('different pull request');
      expect(mergeStarts).toEqual([]);
      expect(clonePaths).toEqual([]);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual([]);
    } else {
      const result = await resumed;
      expect(result, JSON.stringify(await vi.mocked(runWorkflowExecution).mock.results.at(-1)?.value)).toEqual({ merged: true });
      expect(mergeStarts).toHaveLength(1);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual(['thread-target']);
    }
  });

  it.each(['create', 'update', 'pipeline'] as const)('%s handles a self-hosted GitHub PR and skips it for GitLab', async (entry) => {
    for (const provider of ['github', 'gitlab'] as const) {
      // Publication is already successful for the provider comparison.
      const url = configure('ghe.example.test', provider, 'target', entry === 'update');
      const { GitHubProvider } = await import('../infra/github/GitHubProvider.js');
      const { getGitProvider } = await import('../infra/git/index.js');
      const publicProvider = new GitHubProvider();
      const create = vi.spyOn(getGitProvider(), 'createPullRequest').mockImplementation((...args) => publicProvider.createPullRequest(...args));
      const find = vi.spyOn(getGitProvider(), 'findExistingPr').mockImplementation((...args) => publicProvider.findExistingPr(...args));
      const comment = vi.spyOn(getGitProvider(), 'commentOnPr').mockReturnValue({ success: true });
      vi.mocked(runWorkflowExecution).mockClear();
      await publish(entry, 'ghe.example.test/acme/target');
      expect(runWorkflowExecution).toHaveBeenCalledTimes(provider === 'github' ? 1 : 0);
      const api = requests().filter((args) => args[0] === 'api');
      if (provider === 'github') {
        expect(api.length).toBeGreaterThan(0);
        for (const args of api) expect(args.slice(-2)).toEqual(['--hostname', 'ghe.example.test']);
        expect(requests().some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === url)).toBe(true);
      } else expect(api).toHaveLength(0);
      create.mockRestore(); find.mockRestore(); comment.mockRestore();
      writeFileSync(join(root, 'requests.jsonl'), '');
    }
  });

  it.each(['target', 'source'])('keeps the published %s PR identity through fetch, push and Resolve', async (repo) => {
    const url = configure('github.com', 'github', repo);
    const before = Object.fromEntries(Object.entries(remotes).map(([name, path]) => [name, git(root, '--git-dir', path, 'rev-parse', 'refs/heads/feature/pr')]));
    expect(await publish('pipeline', 'acme/' + repo)).toBe(0);
    expect(runWorkflowExecution).toHaveBeenCalledOnce();
    expect(git(root, '--git-dir', remotes[repo]!, 'show', 'refs/heads/feature/pr:fixed.txt')).toBe('published PR fix');
    const other = repo === 'target' ? 'source' : 'target';
    expect(git(root, '--git-dir', remotes[other]!, 'rev-parse', 'refs/heads/feature/pr')).toBe(before[other]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual(['thread-' + repo]);
    const calls = requests();
    expect(calls.find((args) => args[1] === 'create')).toContain('acme/' + repo);
    for (const args of calls.filter((args) => args[0] === 'pr' && args[1] === 'view')) expect(args[2]).toBe(url);
    for (const args of calls.filter((args) => args.includes('graphql') && args.some((arg) => arg.startsWith('repo=')))) expect(args).toContain('repo=' + repo);
    expect(calls.some((args) => args[1]?.startsWith('repos/acme/' + repo + '/commits/'))).toBe(true);
  });

  it.each(['failTarget', 'mismatch'] as const)('does not fall back to the source PR after %s', async (failure) => {
    const url = configure('github.com', 'github', 'target', false, failure);
    const before = git(root, '--git-dir', remotes.source!, 'rev-parse', 'refs/heads/feature/pr');
    expect(await publish('pipeline', 'acme/target')).toBe(0);
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual([]);
    expect(git(root, '--git-dir', remotes.source!, 'rev-parse', 'refs/heads/feature/pr')).toBe(before);
    expect(requests().filter((args) => args[1] === 'view').map((args) => args[2])).toEqual([url]);
  });

  it.each(['target', 'source'])('requests the rate-limited review on the published %s PR before fixing its head', async (repo) => {
    const url = configure('github.com', 'github', repo);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...state, rateLimited: true }));
    expect(await publish('pipeline', 'acme/' + repo)).toBe(0);
    expect(runWorkflowExecution).toHaveBeenCalledOnce();
    expect(requests().filter((args) => args[1] === 'comment')).toEqual([
      ['pr', 'comment', url, '--body', '@coderabbitai review'],
    ]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).resolved).toEqual(['thread-' + repo]);
  });
});
