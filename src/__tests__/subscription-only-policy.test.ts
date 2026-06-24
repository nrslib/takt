import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { findForbiddenSubscriptionOnlyConfigKeyPaths } from '../core/subscription-only/policy.js';
import type { WorkflowConfig } from '../core/models/index.js';

function writeProjectConfig(projectDir: string, content: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), content, 'utf-8');
}

function writeWorkflow(projectDir: string, content: string): string {
  const workflowDir = join(projectDir, '.takt', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  const workflowPath = join(workflowDir, 'subscription.yaml');
  writeFileSync(workflowPath, content, 'utf-8');
  return workflowPath;
}

function makeWorkflow(provider?: WorkflowConfig['provider']): WorkflowConfig {
  return {
    name: 'subscription-policy',
    initialStep: 'plan',
    maxSteps: 3,
    provider,
    steps: [
      {
        name: 'plan',
        persona: 'planner',
        personaDisplayName: 'planner',
        edit: false,
        instruction: '{task}',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('subscription-only policy', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-subscription-policy-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-subscription-policy-global-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (existsSync(globalConfigDir)) {
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('normalizes subscription-only project config fields', () => {
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'allowed_providers:',
      '  - codex-cli',
      '  - cursor-cli',
      'forbidden_providers:',
      '  - codex',
      '  - opencode',
    ].join('\n'));

    const config = loadProjectConfig(projectDir);

    expect(config.subscriptionOnly).toBe(true);
    expect(config.allowedProviders).toEqual(['codex-cli', 'cursor-cli']);
    expect(config.forbiddenProviders).toEqual(['codex', 'opencode']);
  });

  it('detects forbidden API key config nested inside arrays', () => {
    expect(findForbiddenSubscriptionOnlyConfigKeyPaths({
      providers: [{ api_key: 'sk-test' }],
    })).toEqual(['providers[0].api_key']);
  });

  it('rejects API key settings when subscription-only mode is enabled', () => {
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'subscription_only: true',
      'provider: codex-cli',
      'openai_api_key: sk-test',
    ].join('\n'), 'utf-8');

    expect(() => loadGlobalConfig()).toThrow(/subscription-only.*openai_api_key/i);
  });

  it('rejects API providers in project-level routing when subscription-only mode is enabled', () => {
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'provider_routing:',
      '  steps:',
      '    plan:',
      '      provider: codex',
    ].join('\n'));

    expect(() => loadProjectConfig(projectDir)).toThrow(/provider_routing\.steps\.plan.*codex/i);
  });

  it('rejects workflow step API providers during workflow load', () => {
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
    ].join('\n'));
    const workflowPath = writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: codex
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/step "plan".*codex/i);
  });

  it('rejects global API key settings when project config enables effective subscription-only mode', () => {
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'provider: codex-cli',
      'openai_api_key: sk-test',
    ].join('\n'), 'utf-8');
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
    ].join('\n'));
    const workflowPath = writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: codex-cli
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/subscription-only.*openai_api_key/i);
  });

  it('rejects project provider credentials when global config enables effective subscription-only mode', () => {
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'subscription_only: true',
      'provider: codex-cli',
    ].join('\n'), 'utf-8');
    writeProjectConfig(projectDir, [
      'provider: codex-cli',
      'provider_options:',
      '  codex:',
      '    apiKey: sk-test',
    ].join('\n'));
    const workflowPath = writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: codex-cli
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/subscription-only.*provider_options\.codex\.apiKey/i);
  });

  it('surfaces subscription-only provider violations in workflow doctor diagnostics', () => {
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
    ].join('\n'));
    const workflowPath = writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: opencode
    rules:
      - condition: done
        next: COMPLETE
`);

    const messages = inspectWorkflowFile(workflowPath, projectDir).diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages.some((message) => /subscription-only.*opencode/i.test(message))).toBe(true);
  });

  it('rejects execution-time provider overrides that leave the subscription-only allowlist', () => {
    expect(() =>
      validateWorkflowConfig(makeWorkflow(), {
        projectCwd: projectDir,
        provider: 'codex',
        subscriptionOnly: true,
      })
    ).toThrow(/subscription-only.*codex/i);
  });

  it('accepts resolved CLI-only providers in subscription-only execution', () => {
    expect(() =>
      validateWorkflowConfig(makeWorkflow(), {
        projectCwd: projectDir,
        provider: 'codex-cli',
        subscriptionOnly: true,
      })
    ).not.toThrow();
  });
});
