import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { getGlobalConfigPath, getProjectConfigDir, invalidateAllResolvedConfigCache, invalidateGlobalConfigCache, loadProjectConfig } from '../infra/config/index.js';
import { resolveProviderOptionsWithTrace } from '../infra/config/resolveConfigValue.js';
import { resolveProviderOptionsSources } from '../infra/config/providerOptions.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { getBuiltinWorkflow } from '../infra/config/loaders/workflowResolver.js';
import { compileRuntimeProviderEnvironment } from '../infra/config/runtime-provider/environment.js';
import { resolveRuntimeProviderOptions } from '../infra/config/runtime-provider/provider-options.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import type { WorkflowStep } from '../core/models/types.js';

let projectDir: string;

function invalidate(): void {
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

function builder(options: Omit<WorkflowEngineOptions, 'projectCwd'>, steps: WorkflowStep[]): OptionsBuilder {
  return new OptionsBuilder({ ...options, projectCwd: projectDir }, () => projectDir, () => projectDir, () => undefined,
    () => join(projectDir, 'reports'), () => 'en', () => steps, () => 'workflow', () => undefined);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'takt-opencode-skills-'));
  mkdirSync(getProjectConfigDir(projectDir), { recursive: true });
  writeFileSync(getGlobalConfigPath(), '{}');
  invalidate();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidate();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('OpenCode Skill configuration entry points', () => {
  it('resolves global Skill settings and lets project settings override them', () => {
    writeFileSync(getGlobalConfigPath(), stringify({ provider_options: { opencode: { skills: { enabled: true } } } }));
    invalidate();
    const global = resolveProviderOptionsWithTrace(projectDir);
    expect(global.value).toMatchObject({ opencode: { skills: { enabled: true } } });
    expect(global.originResolver('opencode.skills.enabled')).toBe('global');
    expect(resolveProviderOptionsSources(undefined, [], global.value, global.originResolver, global.source))
      .toMatchObject({ 'opencode.skills.enabled': 'global' });
    writeFileSync(join(getProjectConfigDir(projectDir), 'config.yaml'), stringify({ provider_options: { opencode: { skills: { enabled: false } } } }));
    invalidate();
    const local = resolveProviderOptionsWithTrace(projectDir);
    expect(local.value).toMatchObject({ opencode: { skills: { enabled: false } } });
    expect(local.originResolver('opencode.skills.enabled')).toBe('local');
    expect(resolveProviderOptionsSources(undefined, [], local.value, local.originResolver, local.source))
      .toMatchObject({ 'opencode.skills.enabled': 'project' });
  });

  it.each(['root JSON', 'dedicated leaf'])('applies the %s environment override over a project Skill setting', (source) => {
    writeFileSync(join(getProjectConfigDir(projectDir), 'config.yaml'), stringify({ provider_options: { opencode: { skills: { enabled: true } } } }));
    if (source === 'root JSON') vi.stubEnv('TAKT_PROVIDER_OPTIONS', JSON.stringify({ opencode: { skills: { enabled: false } } }));
    else vi.stubEnv('TAKT_PROVIDER_OPTIONS_OPENCODE_SKILLS_ENABLED', 'false');
    invalidate();
    const resolved = resolveProviderOptionsWithTrace(projectDir);
    expect(resolved.value).toMatchObject({ opencode: { skills: { enabled: false } } });
    expect(resolved.originResolver('opencode.skills.enabled')).toBe('env');
    expect(resolveProviderOptionsSources(undefined, [], resolved.value, resolved.originResolver, resolved.source))
      .toMatchObject({ 'opencode.skills.enabled': 'env' });
    vi.unstubAllEnvs();
    invalidate();
    const withoutEnv = resolveProviderOptionsWithTrace(projectDir);
    expect(withoutEnv.value).toMatchObject({ opencode: { skills: { enabled: true } } });
    expect(withoutEnv.originResolver('opencode.skills.enabled')).toBe('local');
  });

  it('does not treat an environment network override as an override of a runtime Skill setting', () => {
    vi.stubEnv('TAKT_PROVIDER_OPTIONS_OPENCODE_NETWORK_ACCESS', 'false');
    const runtime = { opencode: { variant: 'high', skills: { enabled: true } } };
    expect(resolveRuntimeProviderOptions(projectDir, 'opencode', runtime))
      .toMatchObject({ opencode: { networkAccess: false, skills: { enabled: true } } });
  });

  it('applies the dedicated Skill environment override over a runtime profile', () => {
    vi.stubEnv('TAKT_PROVIDER_OPTIONS_OPENCODE_SKILLS_ENABLED', 'false');
    const runtime = { opencode: { variant: 'high', skills: { enabled: true } } };
    expect(resolveRuntimeProviderOptions(projectDir, 'opencode', runtime))
      .toMatchObject({ opencode: { variant: 'high', skills: { enabled: false } } });
  });

  it('passes workflow and step capability Skill settings into execution options', () => {
    mkdirSync(join(projectDir, 'provider-options'));
    writeFileSync(join(projectDir, 'provider-options', 'on.yaml'), 'opencode: {skills: {enabled: true}}');
    writeFileSync(join(projectDir, 'provider-options', 'off.yaml'), 'opencode: {skills: {enabled: false}}');
    const workflow = normalizeWorkflowConfig({ name: 'workflow', capabilities: 'provider-options/on.yaml', steps: [
      { name: 'inherits', instruction: 'task' },
      { name: 'overrides', instruction: 'task', capabilities: 'provider-options/off.yaml' },
    ] }, projectDir);
    const optionsBuilder = builder({ provider: 'opencode', model: 'probe/probe' }, workflow.steps);
    expect(optionsBuilder.buildBaseOptions(workflow.steps[0]!).providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    expect(optionsBuilder.buildBaseOptions(workflow.steps[1]!).providerOptions).toMatchObject({ opencode: { skills: { enabled: false } } });
  });

  it.each(['personas', 'tags', 'steps'] as const)('enables Skill only for the selected runtime %s target', (target) => {
    const steps: WorkflowStep[] = [
      { name: 'implement', personaDisplayName: 'coder', tags: ['coding'], instruction: 'task', passPreviousResponse: false },
      { name: 'plan', personaDisplayName: 'planner', tags: ['planning'], instruction: 'task', passPreviousResponse: false },
    ];
    const key = target === 'personas' ? 'coder' : target === 'tags' ? 'coding' : 'workflow/implement';
    const environment = compileRuntimeProviderEnvironment({ defaults: { profile: 'default' }, profiles: {
      default: { provider: 'opencode', model: 'probe/probe', options: { skills: { enabled: false } } },
      coder: { provider: 'opencode', model: 'probe/probe', options: { skills: { enabled: true } } },
    }, targets: { [target]: { [key]: { profile: 'coder' } } } });
    const optionsBuilder = builder({ ...environment,
      providerRouting: { ...environment.providerRouting, workflowName: 'workflow' },
    }, steps);
    expect(optionsBuilder.buildBaseOptions(steps[0]!).providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    expect(optionsBuilder.buildBaseOptions(steps[1]!).providerOptions).toMatchObject({ opencode: { skills: { enabled: false } } });
  });

  it.each(['personas', 'tags', 'steps'] as const)('loads Skill settings from the legacy %s routing entry', (target) => {
    const key = target === 'personas' ? 'coder' : target === 'tags' ? 'coding' : 'implement';
    const parsed = stringify({ provider_routing: { [target]: { [key]: {
      provider: 'opencode', provider_options: { opencode: { skills: { enabled: true } } },
    } } } });
    writeFileSync(join(getProjectConfigDir(projectDir), 'config.yaml'), parsed);
    invalidate();
    const steps: WorkflowStep[] = [
      { name: 'implement', personaDisplayName: 'coder', providerRoutingPersonaKey: 'coder', tags: ['coding'], instruction: 'task', passPreviousResponse: false },
      { name: 'plan', personaDisplayName: 'planner', providerRoutingPersonaKey: 'planner', tags: ['planning'], instruction: 'task', passPreviousResponse: false },
    ];
    const config = loadProjectConfig(projectDir);
    const optionsBuilder = builder({ provider: 'opencode', providerRouting: config.providerRouting }, steps);
    expect(optionsBuilder.buildBaseOptions(steps[0]!).providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    expect(optionsBuilder.buildBaseOptions(steps[1]!).providerOptions?.opencode ?? {}).not.toMatchObject({ skills: { enabled: true } });
  });

  it('preserves a Skill environment override above routing and step capabilities', () => {
    vi.stubEnv('TAKT_PROVIDER_OPTIONS_OPENCODE_SKILLS_ENABLED', 'false');
    mkdirSync(join(projectDir, 'provider-options'));
    writeFileSync(join(projectDir, 'provider-options', 'on.yaml'), 'opencode: {skills: {enabled: true}}');
    const workflow = normalizeWorkflowConfig({ name: 'workflow', steps: [{
      name: 'implement', instruction: 'task', capabilities: 'provider-options/on.yaml',
    }] }, projectDir);
    const resolved = resolveProviderOptionsWithTrace(projectDir);
    const routed = { opencode: { variant: 'high', skills: { enabled: true } } };
    const optionsBuilder = builder({ provider: 'opencode', providerOptions: resolved.value,
      providerOptionsSource: resolved.source, providerOptionsOriginResolver: resolved.originResolver,
      providerRouting: { steps: { implement: { provider: 'opencode', providerOptions: routed } } },
    }, workflow.steps);
    expect(optionsBuilder.buildBaseOptions(workflow.steps[0]!).providerOptions)
      .toMatchObject({ opencode: { variant: 'high', skills: { enabled: false } } });
  });
});

describe.each(['en', 'ja'])('builtin Skill defaults in %s', (language) => {
  it.each([
    'development-core', 'development-implement', 'development-implement-dynamic', 'development-implement-team',
    'development-remediation', 'development-remediation-dynamic', 'development-remediation-team',
    'simple-core', 'simple-mini', 'simple',
  ])('keeps Skill disabled when loading %s without user overrides', (name) => {
    writeFileSync(join(getProjectConfigDir(projectDir), 'config.yaml'), stringify({ language }));
    invalidate();
    const workflow = getBuiltinWorkflow(name, projectDir);
    expect(workflow).not.toBeNull();
    if (workflow === null) throw new Error('Builtin workflow was not loaded');
    const defaults = resolveProviderOptionsWithTrace(projectDir).value;
    for (const provider of ['codex', 'opencode'] as const) {
      const optionsBuilder = builder({ provider, model: 'probe/probe', providerOptions: defaults }, workflow.steps);
      for (const step of workflow.steps) {
        const options = optionsBuilder.buildBaseOptions(step).providerOptions;
        expect(options?.codex?.skills?.repo ?? false, step.name).toBe(false);
        expect(options?.codex?.skills?.user ?? false, step.name).toBe(false);
        expect(options?.opencode ?? {}, step.name).not.toMatchObject({ skills: { enabled: true } });
      }
    }
  });
});
