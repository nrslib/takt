import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { syncPrCloneEffect } from '../infra/workflow/system/system-pr-code-effects.js';
import type { SystemStepServicesOptions } from '../core/workflow/system/system-step-services.js';
import { syncWithRootEffect, resolveConflictsWithAiEffect } from '../infra/workflow/system/system-sync-effects.js';
import { stageAndCommit } from '../infra/task/git.js';
import { createCheckoutFilter } from './helpers/checkout-filter.js';

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getLanguage: () => 'en',
  resolveConfigValues: () => ({ syncConflictResolver: {} }),
  resolveNonWorkflowProviderModel: () => ({ provider: 'pi', model: 'takt-driver-test/test', permissionMode: 'edit' }),
  resolveNonWorkflowProviderOptions: () => ({}),
}));

describe('PR custom merge drivers and conflict recovery', () => {
  let root: string, cwd: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-pr-drivers-')));
    cwd = join(root, 'clone'); mkdirSync(cwd);
    for (const name of ['global', 'system']) writeFileSync(join(root, name), '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', join(root, 'system'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
    execFileSync('git', ['init', '-b', 'main', join(root, 'project')], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', cwd], { cwd: join(root, 'project'), stdio: 'pipe' });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  function setup(source: string, recursive = false, filterKind?: 'smudge' | 'process') {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Driver Test']); git(['config', 'user.email', 'test@example.test']);
    writeFileSync(join(cwd, '.gitattributes'), `code.txt merge=audit${filterKind ? ' filter=probe' : ''}\n`);
    writeFileSync(join(cwd, 'code.txt'), 'one\nmiddle\nthree\n');
    git(['add', '.gitattributes', 'code.txt']); git(['commit', '-m', 'root']);
    const rootHead = git(['rev-parse', 'HEAD']);
    git(['checkout', '-b', 'feature/pr']);
    writeFileSync(join(cwd, 'code.txt'), 'HEAD\nmiddle\nthree\n'); git(['commit', '-am', 'head']);
    const a = git(['rev-parse', 'HEAD']);
    git(['checkout', 'main']);
    writeFileSync(join(cwd, 'code.txt'), 'one\nmiddle\nBASE\n'); git(['commit', '-am', 'base']);
    const b = git(['rev-parse', 'HEAD']);
    if (recursive) {
      const commit = (content: string, parents: string[]) => {
        writeFileSync(join(cwd, 'code.txt'), content); git(['add', 'code.txt']);
        const tree = git(['write-tree']);
        return git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', 'crisscross']);
      };
      const head = commit('HEAD2\nmiddle\nBASE\n', [a, b]);
      const base = commit('HEAD\nmiddle\nBASE2\n', [b, a]);
      git(['update-ref', 'refs/heads/feature/pr', head]);
      git(['update-ref', 'refs/heads/main', base]);
    }
    git(['checkout', 'feature/pr']);
    const head = git(['rev-parse', 'HEAD']);
    const file = source === 'local' ? join(cwd, '.git', 'config')
      : source === 'include' ? join(root, 'included') : join(root, source === 'system' ? 'system' : 'global');
    if (source === 'include') git(['config', '--file', join(root, 'global'), 'include.path', file]);
    if (source !== 'unconfigured') {
      git(['config', '--file', file, source === 'name' ? 'merge.audit.name' : 'merge.audit.driver',
        'touch "' + join(root, 'audit-marker') + '"; cp %B %A']);
    }
    if (recursive) {
      git(['config', '--file', file, 'merge.audit.recursive', 'nested']);
      git(['config', '--file', file, 'merge.nested.driver', 'touch "' + join(root, 'nested-marker') + '"; cp %B %A']);
      expect(git(['merge-base', '--all', 'feature/pr', 'main']).split('\n').sort()).toEqual([a, b].sort());
      expect(head).not.toBe(rootHead);
    }
    if (filterKind) vi.stubEnv('GIT_CONFIG_GLOBAL', createCheckoutFilter(root, filterKind).configPath);
    git(['remote', 'add', 'base', cwd]);
    const options: SystemStepServicesOptions = { cwd, projectCwd: join(root, 'project'), task: 'Resolve PR 123 conflicts',
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: head,
        headRepositoryUrl: cwd, headRepositoryPushUrls: [cwd] } };
    return { head, options, original: readFileSync(join(cwd, 'code.txt'), 'utf8') };
  }
  function restored(head: string, original: string) {
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['ls-files', '-u'])).toBe('');
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(cwd, 'code.txt'), 'utf8')).toBe(original);
  }

  function setupFilter(kind: 'smudge' | 'process', attributed: boolean, conflict: boolean) {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Filter Test']);
    git(['config', 'user.email', 'test@example.test']);
    writeFileSync(join(cwd, '.gitattributes'), attributed ? 'code.txt filter=probe\n' : '');
    writeFileSync(join(cwd, 'code.txt'), 'one\nmiddle\nthree\n');
    git(['add', '.']); git(['commit', '-m', 'root']);
    git(['checkout', '-b', 'feature/pr']);
    writeFileSync(join(cwd, 'code.txt'), 'HEAD\nmiddle\nthree\n'); git(['commit', '-am', 'head']);
    const head = git(['rev-parse', 'HEAD']);
    const original = readFileSync(join(cwd, 'code.txt'), 'utf8');
    git(['checkout', 'main']);
    writeFileSync(join(cwd, 'code.txt'), conflict ? 'BASE\nmiddle\nthree\n' : 'one\nmiddle\nBASE\n');
    git(['commit', '-am', 'base']); git(['checkout', 'feature/pr']);
    git(['remote', 'add', 'base', cwd]);
    const filter = createCheckoutFilter(root, kind);
    if (kind === 'smudge') git(['config', '--file', filter.configPath, 'filter.probe.clean', 'cat']);
    vi.stubEnv('GIT_CONFIG_GLOBAL', filter.configPath);
    const options: SystemStepServicesOptions = { cwd, projectCwd: join(root, 'project'), task: 'Sync PR 123', allowGitFilters: true,
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: head,
        headRepositoryUrl: cwd, headRepositoryPushUrls: [cwd] } };
    return { ...filter, head, original, options };
  }

  for (const kind of ['smudge', 'process'] as const) {
    for (const attributed of [false, true]) {
      it.each([
        { name: 'sync_with_root', effect: syncWithRootEffect, allowGitFilters: false },
        { name: 'sync_with_root', effect: syncWithRootEffect, allowGitFilters: true },
        { name: 'resolve_conflicts_with_ai', effect: resolveConflictsWithAiEffect, allowGitFilters: false },
        { name: 'resolve_conflicts_with_ai', effect: resolveConflictsWithAiEffect, allowGitFilters: true },
      ])(
        `${kind}属性=${attributed}の$nameはfilter許可=$allowGitFiltersでも同期filterを抑止する`, async ({ effect, allowGitFilters }) => {
          const h = setupFilter(kind, attributed, false);
          git(['merge', '--no-edit', 'main']);
          expect(existsSync(h.markerPath)).toBe(attributed);
          git(['reset', '--hard', h.head]); rmSync(h.markerPath, { force: true });
          expect(await effect({ ...h.options, allowGitFilters }, { pr: 123 })).toMatchObject({ success: true, conflicted: false });
          expect(existsSync(h.markerPath)).toBe(false);
          expect(readFileSync(join(cwd, 'code.txt'), 'utf8')).toBe('HEAD\nmiddle\nBASE\n');
          expect(git(['rev-parse', 'HEAD'])).not.toBe(h.head);
          expect(git(['ls-files', '-u'])).toBe('');
        },
      );

      it(`${kind}属性=${attributed}の競合mergeとabortでfilterを抑止して元の作業ツリーを復元する`, async () => {
        const h = setupFilter(kind, attributed, true);
        expect(() => git(['merge', '--no-edit', 'main'])).toThrow();
        expect(existsSync(h.markerPath)).toBe(attributed);
        git(['merge', '--abort']); rmSync(h.markerPath, { force: true });
        expect(await syncWithRootEffect(h.options, { pr: 123 })).toMatchObject({ success: false, conflicted: true, failed: false });
        expect(existsSync(h.markerPath)).toBe(false);
        restored(h.head, h.original);
      });
    }
  }

  it.each([false, true])('auto-commitはfilter許可=%sの設定を維持する', async (allowGitFilters) => {
    const h = setupFilter('process', true, false);
    writeFileSync(join(cwd, 'code.txt'), 'EDITED\n');
    const commit = await stageAndCommit(cwd, 'fix: filtered change', { ...h.options, allowGitFilters });
    expect(commit).toBeDefined();
    expect(existsSync(h.markerPath)).toBe(allowGitFilters);
    expect(git(['show', 'HEAD:code.txt'])).toBe('EDITED');
    expect(git(['rev-parse', 'HEAD'])).not.toBe(h.head);
  });

  it.each(['global', 'system', 'local', 'include'])('%sの登録driverを実行せず競合としてabortする', async (source) => {
    const h = setup(source);
    git(['merge', '--no-edit', 'main']);
    expect(existsSync(join(root, 'audit-marker'))).toBe(true);
    git(['reset', '--hard', h.head]); rmSync(join(root, 'audit-marker'));
    expect(await syncPrCloneEffect(h.options, { pr: 123 }, false)).toMatchObject({ success: false, failed: false, conflicted: true });
    expect(existsSync(join(root, 'audit-marker'))).toBe(false);
    restored(h.head, h.original);
    expect(git(['config', '--get', 'merge.audit.driver'])).toContain('touch');
  });

  it('登録driverがない通常の同期を成功させる', async () => {
    const h = setup('unconfigured');
    expect(await syncPrCloneEffect(h.options, { pr: 123 }, false)).toMatchObject({ success: true, failed: false, conflicted: false });
    expect(git(['rev-parse', 'HEAD'])).not.toBe(h.head);
    expect(readFileSync(join(cwd, 'code.txt'), 'utf8')).toBe('HEAD\nmiddle\nBASE\n');
  });

  it('表示名だけの設定のcommand line欠落エラーを失敗として保持する', async () => {
    const h = setup('name');
    expect(await syncPrCloneEffect(h.options, { pr: 123 }, true)).toMatchObject({
      success: false, failed: true, conflicted: false, error: expect.stringContaining('lacks command line'),
    });
    expect(existsSync(join(root, 'audit-marker'))).toBe(false);
    restored(h.head, h.original);
  });

  it('共通祖先の再帰mergeでnested driverも実行しない', async () => {
    const h = setup('local', true);
    git(['merge', '--no-edit', 'main']);
    expect(existsSync(join(root, 'nested-marker'))).toBe(true);
    expect(existsSync(join(root, 'audit-marker'))).toBe(true);
    git(['reset', '--hard', h.head]);
    rmSync(join(root, 'nested-marker')); rmSync(join(root, 'audit-marker'));
    expect(await syncPrCloneEffect(h.options, { pr: 123 }, false)).toMatchObject({ success: false, conflicted: true });
    expect(existsSync(join(root, 'nested-marker'))).toBe(false);
    expect(existsSync(join(root, 'audit-marker'))).toBe(false);
    restored(h.head, h.original);
  });

  it.each(['resolved', 'unresolved', 'error', 'abort'])('直接resolverの%s結果からcommitまたはabortする', async (outcome) => {
    const h = setup('local', false, 'process');
    const controller = new AbortController();
    const fake = fauxProvider({ provider: 'takt-driver-test', models: [{ id: 'test' }] });
    const create = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      const runtime = await create(options); runtime.registerNativeProvider(fake.provider); return runtime;
    });
    fake.setResponses([
      () => {
        expect(git(['ls-files', '-u'])).not.toBe('');
        if (outcome === 'abort') { controller.abort(); return fauxAssistantMessage('interrupted'); }
        if (outcome === 'error') throw new Error('resolver failed');
        return outcome === 'resolved'
          ? fauxAssistantMessage(fauxToolCall('bash', { command: 'printf "RESOLVED\\n" > code.txt; git add code.txt' }))
          : fauxAssistantMessage('Unresolved');
      },
      (context) => {
        const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
        expect(result?.isError).toBe(false);
        return fauxAssistantMessage('Resolved');
      },
    ]);
    const result = await syncPrCloneEffect({ ...h.options, abortSignal: controller.signal }, { pr: 123 }, true);
    expect(existsSync(join(root, 'audit-marker'))).toBe(false);
    expect(existsSync(join(root, 'filter-marker'))).toBe(outcome === 'resolved');
    if (outcome === 'resolved') {
      expect(result).toMatchObject({ success: true, conflicted: false });
      expect(git(['rev-parse', 'HEAD'])).not.toBe(h.head);
      expect(git(['ls-files', '-u'])).toBe('');
      expect(readFileSync(join(cwd, 'code.txt'), 'utf8')).toBe('RESOLVED\n');
      expect(git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    } else {
      expect(result).toMatchObject({ success: false, failed: true, conflicted: true });
      restored(h.head, h.original);
    }
  }, 30_000);

  it('AIがHEADと同じ内容で競合を解消した場合もmerge commitを作成する', async () => {
    const h = setup('unconfigured');
    git(['checkout', 'main']);
    writeFileSync(join(cwd, 'code.txt'), 'BASE\nmiddle\nBASE\n');
    git(['commit', '-am', 'conflicting base']);
    git(['checkout', 'feature/pr']);

    const fake = fauxProvider({ provider: 'takt-driver-test', models: [{ id: 'test' }] });
    const create = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      const runtime = await create(options);
      runtime.registerNativeProvider(fake.provider);
      return runtime;
    });
    fake.setResponses([
      () => {
        expect(git(['ls-files', '-u'])).not.toBe('');
        return fauxAssistantMessage(fauxToolCall('bash', {
          command: 'printf "HEAD\\nmiddle\\nthree\\n" > code.txt; git add code.txt',
        }));
      },
      (context) => {
        const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
        expect(result?.isError).toBe(false);
        return fauxAssistantMessage('Resolved');
      },
    ]);

    const result = await syncPrCloneEffect(h.options, { pr: 123 }, true);

    expect(result).toMatchObject({ success: true, conflicted: false });
    expect(git(['ls-files', '-u'])).toBe('');
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect(git(['rev-parse', 'HEAD^{tree}'])).toBe(git(['rev-parse', `${h.head}^{tree}`]));
  }, 30_000);
});
