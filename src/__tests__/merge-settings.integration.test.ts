import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { loadGlobalConfig, saveGlobalConfig, invalidateGlobalConfigCache } from '../infra/config/global/globalConfigCore.js';
import { getGlobalConfigPath } from '../infra/config/paths.js';
import { resolveConfigValue } from '../infra/config/resolveConfigValue.js';

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
    const rawMerge = { workflow: 'custom-merge', method: 'rebase', auto_start: true, include_draft: true,
      include_forks: true, threat_check_max_diff_bytes: 512,
      where: { author: 'alice', labels: ['ready', 'automation'], head_branch: 'takt/*', same_repository: true } };
    const configPath = scope === 'project' ? join(project, '.takt', 'config.yaml') : getGlobalConfigPath();
    const rawManager = { auto_run: false, default_workflow: 'goal-workflow', notifications: { progress: false },
      ...(scope === 'project' ? { main_merge: 'approve' } : {}) };
    writeFileSync(configPath, stringify({ merge: rawMerge, manager: rawManager, concurrency: 3, caccia: { enabled: false } }));
    const load = () => scope === 'project' ? loadProjectConfig(project) : loadGlobalConfig();
    const first = load();
    expect(first).toMatchObject({ merge: { workflow: 'custom-merge', method: 'rebase', autoStart: true,
      includeDraft: true, includeForks: true, threatCheckMaxDiffBytes: 512,
      where: rawMerge.where }, concurrency: 3, caccia: { enabled: false },
      manager: { autoRun: false, defaultWorkflow: 'goal-workflow', notifications: { progress: false },
        ...(scope === 'project' ? { mainMerge: 'approve' } : {}) } });
    if (scope === 'project') saveProjectConfig(project, loadProjectConfig(project));
    else saveGlobalConfig(loadGlobalConfig());
    expect(parse(readFileSync(configPath, 'utf8'))).toMatchObject({ merge: rawMerge, manager: rawManager });
    invalidateGlobalConfigCache();
    expect(load()).toEqual(first);
  });

  it('projectのmerge設定をglobal設定より優先して実行入口へ解決する', () => {
    writeFileSync(getGlobalConfigPath(), stringify({ merge: { method: 'rebase', workflow: 'global-review' } }));
    writeFileSync(join(project, '.takt', 'config.yaml'), stringify({ merge: { method: 'merge', workflow: 'project-review' } }));
    const resolved = Reflect.apply(resolveConfigValue, undefined, [project, 'merge']);
    expect(resolved).toMatchObject({ method: 'merge', workflow: 'project-review' });
  });
});
