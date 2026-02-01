/**
 * Tests for takt config functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getBuiltinWorkflow,
  loadAllWorkflows,
  loadWorkflow,
  listWorkflows,
  loadAgentPromptFromPath,
} from '../config/loader.js';
import {
  getCurrentWorkflow,
  setCurrentWorkflow,
  getProjectConfigDir,
  getBuiltinAgentsDir,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  // Agent session functions
  type AgentSessionData,
  loadAgentSessions,
  updateAgentSession,
  getAgentSessionsPath,
  // Worktree session functions
  getWorktreeSessionsDir,
  encodeWorktreePath,
  getWorktreeSessionPath,
  loadWorktreeSessions,
  updateWorktreeSession,
} from '../config/paths.js';
import { getLanguage } from '../config/globalConfig.js';
import { loadProjectConfig } from '../config/projectConfig.js';

describe('getBuiltinWorkflow', () => {
  it('should return builtin workflow when it exists in resources', () => {
    const workflow = getBuiltinWorkflow('default');
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should return null for non-existent workflow names', () => {
    expect(getBuiltinWorkflow('passthrough')).toBeNull();
    expect(getBuiltinWorkflow('unknown')).toBeNull();
    expect(getBuiltinWorkflow('')).toBeNull();
  });
});

describe('default workflow parallel reviewers step', () => {
  it('should have a reviewers step with parallel sub-steps', () => {
    const workflow = getBuiltinWorkflow('default');
    expect(workflow).not.toBeNull();

    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers');
    expect(reviewersStep).toBeDefined();
    expect(reviewersStep!.parallel).toBeDefined();
    expect(reviewersStep!.parallel).toHaveLength(2);
  });

  it('should have arch-review and security-review as parallel sub-steps', () => {
    const workflow = getBuiltinWorkflow('default');
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;
    const subStepNames = reviewersStep.parallel!.map((s) => s.name);

    expect(subStepNames).toContain('arch-review');
    expect(subStepNames).toContain('security-review');
  });

  it('should have aggregate conditions on the reviewers parent step', () => {
    const workflow = getBuiltinWorkflow('default');
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    expect(reviewersStep.rules).toBeDefined();
    expect(reviewersStep.rules).toHaveLength(2);

    const allRule = reviewersStep.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allRule).toBeDefined();
    expect(allRule!.aggregateConditionText).toBe('approved');
    expect(allRule!.next).toBe('supervise');

    const anyRule = reviewersStep.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyRule).toBeDefined();
    expect(anyRule!.aggregateConditionText).toBe('needs_fix');
    expect(anyRule!.next).toBe('fix');
  });

  it('should have matching conditions on sub-steps for aggregation', () => {
    const workflow = getBuiltinWorkflow('default');
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    for (const subStep of reviewersStep.parallel!) {
      expect(subStep.rules).toBeDefined();
      const conditions = subStep.rules!.map((r) => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });

  it('should have ai_review transitioning to reviewers step', () => {
    const workflow = getBuiltinWorkflow('default');
    const aiReviewStep = workflow!.steps.find((s) => s.name === 'ai_review')!;

    const approveRule = aiReviewStep.rules!.find((r) => r.next === 'reviewers');
    expect(approveRule).toBeDefined();
  });

  it('should have ai_fix transitioning to ai_review step', () => {
    const workflow = getBuiltinWorkflow('default');
    const aiFixStep = workflow!.steps.find((s) => s.name === 'ai_fix')!;

    const fixedRule = aiFixStep.rules!.find((r) => r.next === 'ai_review');
    expect(fixedRule).toBeDefined();
  });

  it('should have fix step transitioning back to reviewers', () => {
    const workflow = getBuiltinWorkflow('default');
    const fixStep = workflow!.steps.find((s) => s.name === 'fix')!;

    const fixedRule = fixStep.rules!.find((r) => r.next === 'reviewers');
    expect(fixedRule).toBeDefined();
  });

  it('should not have old separate review/security_review/improve steps', () => {
    const workflow = getBuiltinWorkflow('default');
    const stepNames = workflow!.steps.map((s) => s.name);

    expect(stepNames).not.toContain('review');
    expect(stepNames).not.toContain('security_review');
    expect(stepNames).not.toContain('improve');
    expect(stepNames).not.toContain('security_fix');
  });

  it('should have sub-steps with correct agents', () => {
    const workflow = getBuiltinWorkflow('default');
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersStep.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.agent).toContain('architecture-reviewer');

    const secReview = reviewersStep.parallel!.find((s) => s.name === 'security-review')!;
    expect(secReview.agent).toContain('security-reviewer');
  });

  it('should have reports configured on sub-steps', () => {
    const workflow = getBuiltinWorkflow('default');
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersStep.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.report).toBeDefined();

    const secReview = reviewersStep.parallel!.find((s) => s.name === 'security-review')!;
    expect(secReview.report).toBeDefined();
  });
});

describe('loadAllWorkflows', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load project-local workflows when cwd is provided', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const sampleWorkflow = `
name: test-workflow
description: Test workflow
max_iterations: 10
steps:
  - name: step1
    agent: coder
    instruction: "{task}"
    rules:
      - condition: Task completed
        next: COMPLETE
`;
    writeFileSync(join(workflowsDir, 'test.yaml'), sampleWorkflow);

    const workflows = loadAllWorkflows(testDir);

    expect(workflows.has('test')).toBe(true);
  });
});

describe('loadWorkflow (builtin fallback)', () => {
  it('should load builtin workflow when user workflow does not exist', () => {
    const workflow = loadWorkflow('default', process.cwd());
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should return null for non-existent workflow', () => {
    const workflow = loadWorkflow('does-not-exist', process.cwd());
    expect(workflow).toBeNull();
  });

  it('should load builtin workflows like simple, research', () => {
    const simple = loadWorkflow('simple', process.cwd());
    expect(simple).not.toBeNull();
    expect(simple!.name).toBe('simple');

    const research = loadWorkflow('research', process.cwd());
    expect(research).not.toBeNull();
    expect(research!.name).toBe('research');
  });
});

describe('listWorkflows (builtin fallback)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should include builtin workflows', () => {
    const workflows = listWorkflows(testDir);
    expect(workflows).toContain('default');
    expect(workflows).toContain('simple');
  });

  it('should return sorted list', () => {
    const workflows = listWorkflows(testDir);
    const sorted = [...workflows].sort();
    expect(workflows).toEqual(sorted);
  });
});

describe('loadAllWorkflows (builtin fallback)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should include builtin workflows in the map', () => {
    const workflows = loadAllWorkflows(testDir);
    expect(workflows.has('default')).toBe(true);
    expect(workflows.has('simple')).toBe(true);
  });
});

describe('loadAgentPromptFromPath (builtin paths)', () => {
  it('should load agent prompt from builtin resources path', () => {
    const lang = getLanguage();
    const builtinAgentsDir = getBuiltinAgentsDir(lang);
    const agentPath = join(builtinAgentsDir, 'default', 'coder.md');

    if (existsSync(agentPath)) {
      const prompt = loadAgentPromptFromPath(agentPath);
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
    }
  });
});

describe('getCurrentWorkflow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return default when no config exists', () => {
    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });

  it('should return saved workflow name from config.yaml', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'workflow: default\n');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });

  it('should return default for empty config', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), '');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });
});

describe('setCurrentWorkflow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save workflow name to config.yaml', () => {
    setCurrentWorkflow(testDir, 'my-workflow');

    const config = loadProjectConfig(testDir);

    expect(config.workflow).toBe('my-workflow');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    setCurrentWorkflow(testDir, 'test');

    expect(existsSync(configDir)).toBe(true);
  });

  it('should overwrite existing workflow name', () => {
    setCurrentWorkflow(testDir, 'first');
    setCurrentWorkflow(testDir, 'second');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('second');
  });
});

describe('loadInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when no history exists', () => {
    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });

  it('should load saved history entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const entries = ['"first entry"', '"second entry"'];
    writeFileSync(getInputHistoryPath(testDir), entries.join('\n'));

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first entry', 'second entry']);
  });

  it('should handle multi-line entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const multiLine = 'line1\nline2\nline3';
    writeFileSync(getInputHistoryPath(testDir), JSON.stringify(multiLine));

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(1);
    expect(history[0]).toBe('line1\nline2\nline3');
  });
});

describe('saveInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save history entries', () => {
    saveInputHistory(testDir, ['entry1', 'entry2']);

    const content = readFileSync(getInputHistoryPath(testDir), 'utf-8');
    expect(content).toBe('"entry1"\n"entry2"');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    saveInputHistory(testDir, ['test']);

    expect(existsSync(configDir)).toBe(true);
  });

  it('should preserve multi-line entries', () => {
    const multiLine = 'line1\nline2';
    saveInputHistory(testDir, [multiLine]);

    const history = loadInputHistory(testDir);

    expect(history[0]).toBe('line1\nline2');
  });
});

describe('addToInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should add new entry to history', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second']);
  });

  it('should not add consecutive duplicates', () => {
    addToInputHistory(testDir, 'same');
    addToInputHistory(testDir, 'same');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['same']);
  });

  it('should allow non-consecutive duplicates', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');
    addToInputHistory(testDir, 'first');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second', 'first']);
  });
});

describe('saveInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should trim history to MAX_INPUT_HISTORY entries', () => {
    const entries = Array.from({ length: 150 }, (_, i) => `entry${i}`);
    saveInputHistory(testDir, entries);

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    // First 50 entries should be trimmed, keeping entries 50-149
    expect(history[0]).toBe('entry50');
    expect(history[MAX_INPUT_HISTORY - 1]).toBe('entry149');
  });

  it('should handle empty history array', () => {
    saveInputHistory(testDir, []);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('loadInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip invalid JSON entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // Mix of valid JSON and invalid entries
    const content = '"valid entry"\ninvalid json\n"another valid"';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // Invalid entries should be skipped
    expect(history).toEqual(['valid entry', 'another valid']);
  });

  it('should handle completely corrupted file', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // All invalid JSON
    const content = 'not json\nalso not json\nstill not json';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // All entries should be skipped
    expect(history).toEqual([]);
  });

  it('should handle file with only whitespace lines', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const content = '   \n\n  \n';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('saveProjectConfig - gitignore copy', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should copy .gitignore when creating new config', () => {
    setCurrentWorkflow(testDir, 'test');

    const configDir = getProjectConfigDir(testDir);
    const gitignorePath = join(configDir, '.gitignore');

    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should copy .gitignore to existing config directory without one', () => {
    // Create config directory without .gitignore
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'workflow: existing\n');

    // Save config should still copy .gitignore
    setCurrentWorkflow(testDir, 'updated');

    const gitignorePath = join(configDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should not overwrite existing .gitignore', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const customContent = '# Custom gitignore\nmy-custom-file';
    writeFileSync(join(configDir, '.gitignore'), customContent);

    setCurrentWorkflow(testDir, 'test');

    const gitignorePath = join(configDir, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe(customContent);
  });
});

// ============ Worktree Sessions ============

describe('encodeWorktreePath', () => {
  it('should replace slashes with dashes', () => {
    const encoded = encodeWorktreePath('/project/.takt/worktrees/my-task');

    expect(encoded).not.toContain('/');
    expect(encoded).toContain('-');
  });

  it('should handle Windows-style paths', () => {
    const encoded = encodeWorktreePath('C:\\project\\worktrees\\task');

    expect(encoded).not.toContain('\\');
    expect(encoded).not.toContain(':');
  });

  it('should produce consistent output for same input', () => {
    const path = '/project/.takt/worktrees/feature-x';
    const encoded1 = encodeWorktreePath(path);
    const encoded2 = encodeWorktreePath(path);

    expect(encoded1).toBe(encoded2);
  });
});

describe('getWorktreeSessionsDir', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return path inside .takt directory', () => {
    const sessionsDir = getWorktreeSessionsDir(testDir);

    expect(sessionsDir).toContain('.takt');
    expect(sessionsDir).toContain('worktree-sessions');
  });
});

describe('getWorktreeSessionPath', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return .json file path', () => {
    const sessionPath = getWorktreeSessionPath(testDir, '/worktree/path');

    expect(sessionPath).toMatch(/\.json$/);
  });

  it('should include encoded worktree path in filename', () => {
    const worktreePath = '/project/.takt/worktrees/my-feature';
    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);

    expect(sessionPath).toContain('worktree-sessions');
  });
});

describe('loadWorktreeSessions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty object when no session file exists', () => {
    const sessions = loadWorktreeSessions(testDir, '/some/worktree');

    expect(sessions).toEqual({});
  });

  it('should load saved sessions from file', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
    const data = {
      agentSessions: { coder: 'session-123', reviewer: 'session-456' },
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(data));

    const sessions = loadWorktreeSessions(testDir, worktreePath);

    expect(sessions).toEqual({ coder: 'session-123', reviewer: 'session-456' });
  });

  it('should return empty object for corrupted JSON', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
    writeFileSync(sessionPath, 'not valid json');

    const sessions = loadWorktreeSessions(testDir, worktreePath);

    expect(sessions).toEqual({});
  });
});

describe('updateWorktreeSession', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create session file if not exists', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-abc');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions).toEqual({ coder: 'session-abc' });
  });

  it('should update existing session', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1');
    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-2');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions.coder).toBe('session-2');
  });

  it('should preserve other agent sessions when updating one', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'coder-session');
    updateWorktreeSession(testDir, worktreePath, 'reviewer', 'reviewer-session');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions).toEqual({
      coder: 'coder-session',
      reviewer: 'reviewer-session',
    });
  });

  it('should create worktree-sessions directory if not exists', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    expect(existsSync(sessionsDir)).toBe(false);

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-xyz');

    expect(existsSync(sessionsDir)).toBe(true);
  });

  it('should keep sessions isolated between different worktrees', () => {
    const worktree1 = '/project/worktree-1';
    const worktree2 = '/project/worktree-2';

    updateWorktreeSession(testDir, worktree1, 'coder', 'wt1-session');
    updateWorktreeSession(testDir, worktree2, 'coder', 'wt2-session');

    const sessions1 = loadWorktreeSessions(testDir, worktree1);
    const sessions2 = loadWorktreeSessions(testDir, worktree2);

    expect(sessions1.coder).toBe('wt1-session');
    expect(sessions2.coder).toBe('wt2-session');
  });
});

describe('provider-based session management', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadAgentSessions with provider', () => {
    it('should return sessions when provider matches', () => {
      updateAgentSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadAgentSessions(testDir, 'claude');
      expect(sessions.coder).toBe('session-1');
    });

    it('should return empty when provider has changed', () => {
      updateAgentSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadAgentSessions(testDir, 'codex');
      expect(sessions).toEqual({});
    });

    it('should return sessions when no provider is specified (legacy)', () => {
      updateAgentSession(testDir, 'coder', 'session-1');

      const sessions = loadAgentSessions(testDir);
      expect(sessions.coder).toBe('session-1');
    });
  });

  describe('updateAgentSession with provider', () => {
    it('should discard old sessions when provider changes', () => {
      updateAgentSession(testDir, 'coder', 'claude-session', 'claude');
      updateAgentSession(testDir, 'coder', 'codex-session', 'codex');

      const sessions = loadAgentSessions(testDir, 'codex');
      expect(sessions.coder).toBe('codex-session');
      // Old claude sessions should not remain
      expect(Object.keys(sessions)).toHaveLength(1);
    });

    it('should store provider in session data', () => {
      updateAgentSession(testDir, 'coder', 'session-1', 'claude');

      const path = getAgentSessionsPath(testDir);
      const data = JSON.parse(readFileSync(path, 'utf-8')) as AgentSessionData;
      expect(data.provider).toBe('claude');
    });
  });

  describe('loadWorktreeSessions with provider', () => {
    it('should return sessions when provider matches', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'claude');
      expect(sessions.coder).toBe('session-1');
    });

    it('should return empty when provider has changed', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'codex');
      expect(sessions).toEqual({});
    });
  });

  describe('updateWorktreeSession with provider', () => {
    it('should discard old sessions when provider changes', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'claude-session', 'claude');
      updateWorktreeSession(testDir, worktreePath, 'coder', 'codex-session', 'codex');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'codex');
      expect(sessions.coder).toBe('codex-session');
      expect(Object.keys(sessions)).toHaveLength(1);
    });

    it('should store provider in session data', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
      const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as AgentSessionData;
      expect(data.provider).toBe('claude');
    });
  });
});
