import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupResources } from '../helpers/cleanup';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { readSessionRecords } from '../helpers/session-log';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const provider = process.env.TAKT_E2E_PROVIDER;
const providerIt = provider === 'claude' || provider === 'claude-sdk' ? it : it.skip;

function writeSkillVisibilityWorkflow(repoPath: string): string {
  const workflowPath = join(repoPath, 'claude-skills-workflow.yaml');
  writeFileSync(
    workflowPath,
    [
      'name: claude-skills-e2e',
      'description: Verify Claude Skill metadata visibility',
      'max_steps: 1',
      'initial_step: check_skill',
      'steps:',
      '  - name: check_skill',
      '    edit: false',
      '    persona: |',
      '      You report the Claude Skills supplied in the initial context.',
      '    instruction: |',
      '      Do not use any tools or read any files.',
      '      List only the exact names of Skills supplied in the initial context, one per line.',
      '      If no Skills are supplied, answer exactly NONE.',
      '    rules:',
      '      - condition: The response lists the supplied Skill names or NONE.',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  return workflowPath;
}

function createSentinelSkill(repoPath: string): string {
  const skillName = `takt-sentinel-${randomUUID().replaceAll('-', '')}`;
  const skillDirectory = join(repoPath, '.claude', 'skills', skillName);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: Sentinel Skill used only to verify metadata visibility.',
      '---',
      '',
      '# Sentinel',
    ].join('\n'),
    'utf-8',
  );
  return skillName;
}

function getStepContent(repoPath: string): string | undefined {
  const record = readSessionRecords(repoPath)
    .find((entry) => entry.type === 'phase_complete' && entry.phaseName === 'execute');
  return typeof record?.content === 'string' ? record.content.trim() : undefined;
}

describe('E2E: Claude filesystem Skill metadata', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let skillName: string;
  let workflowPath: string;
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    cleanups = [];
    isolatedEnv = createIsolatedEnv();
    cleanups.unshift(isolatedEnv.cleanup);
    repo = createLocalRepo();
    cleanups.unshift(repo.cleanup);
    skillName = createSentinelSkill(repo.path);
    workflowPath = writeSkillVisibilityWorkflow(repo.path);
  });

  afterEach(() => {
    cleanupResources(...cleanups);
  });

  function runSkillVisibilityCheck(enabled: boolean) {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider_options: {
        claude: {
          skills: { enabled },
        },
      },
    });

    return runTakt({
      args: ['--task', 'List the Skills supplied in the initial context.', '--workflow', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });
  }

  providerIt('does not report the project Skill name when disabled', () => {
    const result = runSkillVisibilityCheck(false);

    expect(result.exitCode).toBe(0);
    const content = getStepContent(repo.path);
    expect(content).toBeDefined();
    const listedSkillNames = content?.split(/\r?\n/).map((line) => line.trim());
    expect(listedSkillNames).not.toContain(skillName);
  }, 240_000);

  providerIt('reports the project Skill name when enabled', () => {
    const result = runSkillVisibilityCheck(true);

    expect(result.exitCode).toBe(0);
    const content = getStepContent(repo.path);
    expect(content).toBeDefined();
    const listedSkillNames = content?.split(/\r?\n/).map((line) => line.trim());
    expect(listedSkillNames).toContain(skillName);
  }, 240_000);
});
