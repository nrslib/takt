import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPersonaPromptFromPath } from '../infra/config/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'takt-workflow-security-'));
}

describe('workflow persona path security', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('should reject runtime persona prompt paths outside allowed roots', () => {
    const projectDir = createTempDir();
    const outsideDir = createTempDir();
    tempDirs.push(projectDir, outsideDir);

    const secretPath = join(outsideDir, 'secret.md');
    writeFileSync(secretPath, 'top secret', 'utf-8');

    expect(() => loadPersonaPromptFromPath(secretPath, projectDir)).toThrow(/not allowed/i);
  });

  it('should reject runtime persona prompt paths under unrelated workflow directories', () => {
    const projectDir = createTempDir();
    const outsideDir = createTempDir();
    tempDirs.push(projectDir, outsideDir);

    const secretWorkflowDir = join(outsideDir, 'workflows');
    mkdirSync(secretWorkflowDir, { recursive: true });

    const secretPath = join(secretWorkflowDir, 'secret.md');
    writeFileSync(secretPath, 'top secret', 'utf-8');

    expect(() => loadPersonaPromptFromPath(secretPath, projectDir)).toThrow(/not allowed/i);
  });

  it('should reject workflow persona paths outside the workflow roots during normalization', () => {
    const projectDir = createTempDir();
    const outsideDir = createTempDir();
    tempDirs.push(projectDir, outsideDir);

    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    const secretPath = join(outsideDir, 'secret.md');
    writeFileSync(secretPath, 'top secret', 'utf-8');

    const raw = {
      name: 'unsafe-persona',
      steps: [
        {
          name: 'plan',
          persona: secretPath,
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, workflowDir, {
      lang: 'ja',
      projectDir,
      workflowDir,
      repertoireDir: join(projectDir, '.takt', 'repertoire'),
    })).toThrow(/not allowed/i);
  });

  it('should reject symlinked persona prompts that escape the allowed workflow roots', () => {
    const projectDir = createTempDir();
    const outsideDir = createTempDir();
    tempDirs.push(projectDir, outsideDir);

    const workflowDir = join(projectDir, '.takt', 'workflows');
    const agentsDir = join(projectDir, '.takt', 'agents');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });

    const secretPath = join(outsideDir, 'secret.md');
    const symlinkPath = join(agentsDir, 'secret-link.md');
    writeFileSync(secretPath, 'top secret', 'utf-8');
    symlinkSync(secretPath, symlinkPath);

    const raw = {
      name: 'symlink-persona',
      steps: [
        {
          name: 'plan',
          persona: '../agents/secret-link.md',
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, workflowDir, {
      lang: 'ja',
      projectDir,
      workflowDir,
      repertoireDir: join(projectDir, '.takt', 'repertoire'),
    })).toThrow(/not allowed/i);
  });

  it('should reject symlinked persona prompts that escape allowed roots at runtime load', () => {
    const projectDir = createTempDir();
    const outsideDir = createTempDir();
    tempDirs.push(projectDir, outsideDir);

    const agentsDir = join(projectDir, '.takt', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const secretPath = join(outsideDir, 'secret.md');
    const symlinkPath = join(agentsDir, 'secret-link.md');
    writeFileSync(secretPath, 'top secret', 'utf-8');
    symlinkSync(secretPath, symlinkPath);

    expect(() => loadPersonaPromptFromPath(symlinkPath, projectDir)).toThrow(/not allowed/i);
  });
});
