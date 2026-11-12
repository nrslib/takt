import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { loadGlobalConfig, saveGlobalConfig, invalidateGlobalConfigCache } from '../infra/config/global/globalConfigCore.js';
import { getGlobalConfigPath } from '../infra/config/paths.js';
import { resolveConfigValue } from '../infra/config/resolveConfigValue.js';
import { loadGlobalConfigTrace, loadProjectConfigTrace } from '../infra/config/traced/tracedConfigLoader.js';
import { resolveMergeSettings } from '../features/merge/settings.js';

describe('Merge settings persistence', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'takt-merge-config-'));
    mkdirSync(join(project, '.takt'));
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    invalidateGlobalConfigCache();
    rmSync(project, { recursive: true, force: true });
  });

  it.each(['project', 'global'])('%s設定を読込・保存・再読込してmerge条件と方式を保持する', (scope) => {
    const rawMerge = { workflow: 'custom-merge', prepare_workflow: 'custom-prepare', method: 'rebase', auto_start: true, include_draft: true,
      include_forks: true, threat_check_max_diff_bytes: 512,
      where: { author: 'alice', labels: ['ready', 'automation'], head_branch: 'takt/*', same_repository: true } };
    const configPath = scope === 'project' ? join(project, '.takt', 'config.yaml') : getGlobalConfigPath();
    const rawManager = { auto_run: false, notifications: { progress: false },
      ...(scope === 'project' ? { main_merge: 'approve' } : {}) };
    writeFileSync(configPath, stringify({ merge: rawMerge, manager: rawManager, concurrency: 3, caccia: { enabled: false } }));
    const load = () => scope === 'project' ? loadProjectConfig(project) : loadGlobalConfig();
    const first = load();
    expect(first).toMatchObject({ merge: { workflow: 'custom-merge', prepareWorkflow: 'custom-prepare', method: 'rebase', autoStart: true,
      includeDraft: true, includeForks: true, threatCheckMaxDiffBytes: 512,
      where: rawMerge.where }, concurrency: 3, caccia: { enabled: false },
      manager: { autoRun: false, notifications: { progress: false },
        ...(scope === 'project' ? { mainMerge: 'approve' } : {}) } });
    if (scope === 'project') saveProjectConfig(project, loadProjectConfig(project));
    else saveGlobalConfig(loadGlobalConfig());
    expect(parse(readFileSync(configPath, 'utf8'))).toMatchObject({ merge: rawMerge, manager: rawManager });
    invalidateGlobalConfigCache();
    expect(load()).toEqual(first);
  });

  it('projectのmerge設定をprovenance付きで読みglobal設定より優先して実行入口へ解決する', () => {
    const globalConfigPath = getGlobalConfigPath();
    const projectConfigPath = join(project, '.takt', 'config.yaml');
    writeFileSync(globalConfigPath, stringify({ merge: { method: 'rebase', workflow: 'global-review', prepare_workflow: 'global-prepare' } }));
    writeFileSync(projectConfigPath, stringify({ merge: { method: 'merge', workflow: 'project-review', prepare_workflow: 'project-prepare' } }));

    const projectTrace = loadProjectConfigTrace(projectConfigPath, []);
    const globalTrace = loadGlobalConfigTrace(globalConfigPath, (value) => value, []);
    const resolved = resolveMergeSettings(resolveConfigValue(project, 'merge'));

    expect(projectTrace.rawConfig).toMatchObject({ merge: { prepare_workflow: 'project-prepare' } });
    expect(projectTrace.trace.getOrigin('merge.prepare_workflow')).toBe('local');
    expect(globalTrace.rawConfig).toMatchObject({ merge: { prepare_workflow: 'global-prepare' } });
    expect(globalTrace.trace.getOrigin('merge.prepare_workflow')).toBe('global');
    expect(resolved).toMatchObject({ method: 'merge', workflow: 'project-review', prepareWorkflow: 'project-prepare' });
  });
});
