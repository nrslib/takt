import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { createWorkflowCallResolver, createWorkflowExecutionContext } from '../features/tasks/execute/workflowExecutionContext.js';
import { getGlobalConfigPath, getRepertoireDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache, loadGlobalConfig, saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { loadProjectConfig, saveProjectConfig, updateProjectConfig } from '../infra/config/project/projectConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolutionCache.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/config-schemas.js';
import { loadGlobalConfigTraceState } from '../infra/config/global/globalConfigCore.js';

describe('command system input configuration', () => {
  let projectDir: string;
  let workflowPath: string;

  function writeGlobal(raw: Record<string, unknown>): void {
    const path = getGlobalConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stringify(raw));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  }

  function writeProject(raw: Record<string, unknown>): void {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringify(raw));
    invalidateAllResolvedConfigCache();
  }

  function writeWorkflow(): void {
    writeFileSync(workflowPath, stringify({
      name: 'command-input',
      steps: [{
        name: 'approval', mode: 'system',
        system_inputs: [{ type: 'command', as: 'result', command: 'printf approved', timeout_ms: 2147483647 }],
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
      }],
    }));
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('TAKT_WORKFLOW_SYSTEM_COMMANDS', undefined);
    vi.stubEnv('TAKT_WORKFLOW_SYSTEM_COMMANDS_CUSTOM_SCRIPTS', undefined);
    projectDir = mkdtempSync(join(tmpdir(), 'takt-command-config-'));
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    workflowPath = join(projectDir, '.takt', 'workflows', 'command.yaml');
    vi.stubEnv('TAKT_WORKFLOW_SYSTEM_COMMANDS_TRUSTED_PROJECTS', undefined);
    writeGlobal({ workflow_system_commands_trusted_projects: [projectDir] });
    writeProject({});
    writeWorkflow();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([
    { roots: 'same', global: false, project: true, allowed: true },
    { roots: 'empty', global: false, project: true, allowed: true },
    { roots: 'absent', global: undefined, project: true, allowed: true },
    { roots: 'parent', global: false, project: true, allowed: true },
    { roots: 'other', global: false, project: true, allowed: true },
    { roots: 'missing', global: false, project: true, allowed: true },
    { roots: 'same', global: true, project: false, allowed: false },
    { roots: 'empty', global: true, project: false, allowed: false },
    { roots: 'empty', global: true, project: true, allowed: true },
    { roots: 'empty', global: true, project: undefined, allowed: true },
    { roots: 'same', global: true, project: undefined, allowed: true },
    { roots: 'same', global: false, project: undefined, allowed: false },
    { roots: 'empty', global: false, project: false, allowed: false },
    { roots: 'empty', global: false, project: undefined, allowed: false },
    { roots: 'absent', global: undefined, project: undefined, allowed: false },
  ])('resolves global $global and project $project regardless of registration $roots', ({ roots, global, project, allowed }) => {
    const other = join(projectDir, 'other');
    mkdirSync(other);
    const registered = roots === 'same' ? [projectDir] : roots === 'parent' ? [dirname(projectDir)]
      : roots === 'other' ? [other] : roots === 'missing' ? [join(projectDir, 'missing')] : [];
    writeGlobal({
      ...(roots === 'absent' ? {} : { workflow_system_commands_trusted_projects: registered }),
      ...(global === undefined ? {} : { workflow_system_commands: { custom_scripts: global } }),
    });
    writeProject(project === undefined ? {} : { workflow_system_commands: { custom_scripts: project } });
    const scopedDirectory = join(getRepertoireDir(), '@owner', 'repo', 'workflows');
    mkdirSync(scopedDirectory, { recursive: true });
    writeFileSync(join(scopedDirectory, 'command.yaml'), readFileSync(workflowPath));
    for (const load of [() => loadWorkflowFromFile(workflowPath, projectDir),
      () => loadWorkflowByIdentifier(workflowPath, projectDir),
      () => loadWorkflowByIdentifier('command', projectDir),
      () => loadWorkflowByIdentifier('@owner/repo/command', projectDir)]) {
      if (allowed) expect(load()?.steps[0]?.systemInputs).toHaveLength(1);
      else expect(load).toThrow();
    }
  });

  it('preserves global-only registrations through save, reload, environment and trace', () => {
    writeGlobal({ workflow_system_commands_trusted_projects: [projectDir] });
    saveGlobalConfig({ ...loadGlobalConfig(), language: 'ja' });
    invalidateGlobalConfigCache();
    expect(loadGlobalConfig().workflowSystemCommandsTrustedProjects).toEqual([projectDir]);
    expect(loadGlobalConfigTraceState().getOrigin('workflow_system_commands_trusted_projects')).toBe('global');
    expect(parse(readFileSync(getGlobalConfigPath(), 'utf8')).workflow_system_commands_trusted_projects).toEqual([projectDir]);
    expect(ProjectConfigSchema.safeParse({ workflow_system_commands_trusted_projects: [projectDir] }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ workflow_system_commands_trusted_projects: ['relative'] }).success).toBe(false);
    vi.stubEnv('TAKT_WORKFLOW_SYSTEM_COMMANDS_TRUSTED_PROJECTS', JSON.stringify([projectDir]));
    writeGlobal({});
    writeProject({ workflow_system_commands: { custom_scripts: true } });
    expect(loadGlobalConfig().workflowSystemCommandsTrustedProjects).toEqual([projectDir]);
    expect(loadProjectConfig(projectDir)).not.toHaveProperty('workflowSystemCommandsTrustedProjects');
    expect(loadGlobalConfigTraceState().getOrigin('workflow_system_commands_trusted_projects')).toBe('env');
    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]?.systemInputs).toHaveLength(1);
  });

  it('rejects command inputs without dedicated permission', () => {
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it('does not use command gate permission for system commands', () => {
    writeProject({ workflow_command_gates: { custom_scripts: true } });
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it.each([
    { global: true, project: undefined, allowed: true },
    { global: false, project: true, allowed: true },
    { global: true, project: false, allowed: false },
    { global: undefined, project: true, allowed: true },
    { global: true, project: {}, allowed: true },
  ])('resolves global $global and project $project permission', ({ global, project, allowed }) => {
    writeGlobal({ workflow_system_commands_trusted_projects: [projectDir],
      ...(global === undefined ? {} : { workflow_system_commands: { custom_scripts: global } }),
    });
    writeProject(project === undefined ? {} : {
      workflow_system_commands: typeof project === 'boolean' ? { custom_scripts: project } : project,
    });
    if (!allowed) {
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
      return;
    }
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    expect(workflow.steps[0]?.systemInputs).toEqual([
      { type: 'command', as: 'result', command: 'printf approved', timeout_ms: 2147483647 },
    ]);
  });

  it('does not use system command permission for command gates', () => {
    writeProject({ workflow_system_commands: { custom_scripts: true } });
    writeFileSync(workflowPath, stringify({
      name: 'gate', steps: [{ name: 'check', instruction: 'check',
        quality_gates: [{ type: 'command', command: 'printf approved' }],
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }));
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
  });

  it.each([true, false])('preserves global permission %s through save and reload', (customScripts) => {
    writeGlobal({ workflow_system_commands: { custom_scripts: customScripts } });
    const loaded = loadGlobalConfig();
    expect(loaded).toMatchObject({ workflowSystemCommands: { customScripts } });
    saveGlobalConfig({ ...loaded, language: 'ja' });
    invalidateGlobalConfigCache();
    expect(parse(readFileSync(getGlobalConfigPath(), 'utf8'))).toMatchObject({
      workflow_system_commands: { custom_scripts: customScripts },
    });
    expect(loadGlobalConfig()).toMatchObject({ workflowSystemCommands: { customScripts } });
  });

  it.each([true, false])('preserves project permission %s through update and reload', (customScripts) => {
    writeProject({ workflow_system_commands: { custom_scripts: customScripts } });
    const loaded = loadProjectConfig(projectDir);
    expect(loaded).toMatchObject({ workflowSystemCommands: { customScripts } });
    saveProjectConfig(projectDir, loaded);
    updateProjectConfig(projectDir, 'language', 'ja');
    expect(parse(readFileSync(join(projectDir, '.takt', 'config.yaml'), 'utf8'))).toMatchObject({
      workflow_system_commands: { custom_scripts: customScripts },
    });
    expect(loadProjectConfig(projectDir)).toMatchObject({ workflowSystemCommands: { customScripts } });
  });

  it.each([
    ['TAKT_WORKFLOW_SYSTEM_COMMANDS_CUSTOM_SCRIPTS', 'true'],
    ['TAKT_WORKFLOW_SYSTEM_COMMANDS', '{"custom_scripts":true}'],
  ])('applies %s through the existing configuration environment', (key, value) => {
    vi.stubEnv(key, value);
    expect(loadGlobalConfig()).toMatchObject({ workflowSystemCommands: { customScripts: true } });
    expect(loadProjectConfig(projectDir)).toMatchObject({ workflowSystemCommands: { customScripts: true } });
    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]?.systemInputs).toHaveLength(1);
  });

  it.each([
    ["'printf {previous_response}'", 'printf {previous_response}'],
    ['"printf {previous_response}"', 'printf {previous_response}'],
    ['|\n          printf {previous_response}\n', 'printf {previous_response}\n'],
  ])('preserves the parsed command from YAML %s', (scalar, expected) => {
    writeProject({ workflow_system_commands: { custom_scripts: true } });
    writeFileSync(workflowPath, `name: literal-command
steps:
  - name: approval
    mode: system
    system_inputs:
      - type: command
        as: result
        timeout_ms: 1000
        command: ${scalar}
    rules:
      - condition: when(true)
        next: COMPLETE
`);
    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]?.systemInputs?.[0]).toMatchObject({ command: expected });
  });

  it.each([true, false])('applies dedicated permission %s when resolving a callable child workflow', (allowed) => {
    const childPath = join(projectDir, '.takt', 'workflows', 'child.yaml');
    writeFileSync(childPath, stringify({
      name: 'child', subworkflow: { callable: true },
      steps: [{ name: 'check', mode: 'system', system_inputs: [{
        type: 'command', as: 'approval', command: 'printf approved', timeout_ms: 1000,
      }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }));
    writeFileSync(workflowPath, stringify({
      name: 'parent', steps: [{ name: 'delegate', kind: 'workflow_call', call: './child.yaml',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    }));
    const parent = loadWorkflowFromFile(workflowPath, projectDir);
    const call = parent.steps[0]!;
    if (call.kind !== 'workflow_call') throw new Error('Expected workflow call step');
    writeProject({ workflow_system_commands: { custom_scripts: allowed } });
    if (!allowed) {
      expect(() => resolveWorkflowCallTarget(parent, call, projectDir)).toThrow();
      return;
    }
    const child = resolveWorkflowCallTarget(parent, call, projectDir);
    expect(child?.steps[0]?.systemInputs?.[0]).toMatchObject({ type: 'command', command: 'printf approved' });
  });

  it.each([true, false])('applies project permission %s through recursive child validation', (allowed) => {
    writeGlobal({ workflow_system_commands: { custom_scripts: false } });
    writeProject({ workflow_system_commands: { custom_scripts: allowed } });
    const commandWorkflow = parse(readFileSync(workflowPath, 'utf8'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'command-child.yaml'), stringify({
      ...commandWorkflow, subworkflow: { callable: true },
    }));
    const parent = (name: string, call: string) => ({
      name, subworkflow: { callable: true }, steps: [{
        name: 'delegate', kind: 'workflow_call', call,
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    writeFileSync(join(projectDir, '.takt', 'workflows', 'child.yaml'), stringify(parent('child', './command-child.yaml')));
    writeFileSync(workflowPath, stringify(parent('parent', './child.yaml')));
    const load = () => loadWorkflowByIdentifier(workflowPath, projectDir);
    if (allowed) expect(load()?.name).toBe('parent');
    else expect(load).toThrow();
  });

  it.each([true, false])('keeps run permission %s when resolving a child for its bundle', (allowed) => {
    writeProject({ workflow_system_commands: { custom_scripts: true } });
    const child = parse(readFileSync(workflowPath, 'utf8'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'child.yaml'), stringify({
      ...child, subworkflow: { callable: true },
    }));
    writeFileSync(workflowPath, stringify({
      name: 'parent', steps: [{ name: 'delegate', kind: 'workflow_call', call: './child.yaml',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    }));
    const parent = loadWorkflowFromFile(workflowPath, projectDir);
    const call = parent.steps[0]!;
    if (call.kind !== 'workflow_call') throw new Error('Expected workflow call step');
    const resolver = createWorkflowCallResolver(createWorkflowExecutionContext(
      parent, projectDir, undefined, { customScripts: allowed },
    ));
    writeProject({ workflow_system_commands: { custom_scripts: !allowed } });
    const resolve = () => resolver({ parentWorkflow: parent, step: call, projectCwd: projectDir, lookupCwd: projectDir });
    if (allowed) expect(resolve()?.steps[0]?.systemInputs).toHaveLength(1);
    else expect(resolve).toThrow();
  });
});
