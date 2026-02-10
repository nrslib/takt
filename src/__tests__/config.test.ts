/**
 * Tests for takt config functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getBuiltinPiece,
  loadAllPieces,
  loadPiece,
  listPieces,
  loadPersonaPromptFromPath,
  getCurrentPiece,
  setCurrentPiece,
  getProjectConfigDir,
  getBuiltinPersonasDir,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  // Persona session functions
  type PersonaSessionData,
  loadPersonaSessions,
  updatePersonaSession,
  getPersonaSessionsPath,
  // Worktree session functions
  getWorktreeSessionsDir,
  encodeWorktreePath,
  getWorktreeSessionPath,
  loadWorktreeSessions,
  updateWorktreeSession,
  getLanguage,
  loadProjectConfig,
} from '../infra/config/index.js';

describe('getBuiltinPiece', () => {
  it('should return builtin piece when it exists in resources', () => {
    const piece = getBuiltinPiece('default');
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('default');
  });

  it('should resolve builtin instruction_template without projectCwd', () => {
    const piece = getBuiltinPiece('default');
    expect(piece).not.toBeNull();

    const planMovement = piece!.movements.find((movement) => movement.name === 'plan');
    expect(planMovement).toBeDefined();
    expect(planMovement!.instructionTemplate).not.toBe('plan');
  });

  it('should return null for non-existent piece names', () => {
    expect(getBuiltinPiece('nonexistent-piece')).toBeNull();
    expect(getBuiltinPiece('unknown')).toBeNull();
    expect(getBuiltinPiece('')).toBeNull();
  });
});

describe('default piece parallel reviewers movement', () => {
  it('should have a reviewers movement with parallel sub-movements', () => {
    const piece = getBuiltinPiece('default');
    expect(piece).not.toBeNull();

    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers');
    expect(reviewersMovement).toBeDefined();
    expect(reviewersMovement!.parallel).toBeDefined();
    expect(reviewersMovement!.parallel).toHaveLength(2);
  });

  it('should have arch-review and qa-review as parallel sub-movements', () => {
    const piece = getBuiltinPiece('default');
    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers')!;
    const subMovementNames = reviewersMovement.parallel!.map((s) => s.name);

    expect(subMovementNames).toContain('arch-review');
    expect(subMovementNames).toContain('qa-review');
  });

  it('should have aggregate conditions on the reviewers parent movement', () => {
    const piece = getBuiltinPiece('default');
    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers')!;

    expect(reviewersMovement.rules).toBeDefined();
    expect(reviewersMovement.rules).toHaveLength(2);

    const allRule = reviewersMovement.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allRule).toBeDefined();
    expect(allRule!.aggregateConditionText).toBe('approved');
    expect(allRule!.next).toBe('supervise');

    const anyRule = reviewersMovement.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyRule).toBeDefined();
    expect(anyRule!.aggregateConditionText).toBe('needs_fix');
    expect(anyRule!.next).toBe('fix');
  });

  it('should have matching conditions on sub-movements for aggregation', () => {
    const piece = getBuiltinPiece('default');
    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers')!;

    for (const subMovement of reviewersMovement.parallel!) {
      expect(subMovement.rules).toBeDefined();
      const conditions = subMovement.rules!.map((r) => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });

  it('should have ai_review transitioning to reviewers movement', () => {
    const piece = getBuiltinPiece('default');
    const aiReviewMovement = piece!.movements.find((s) => s.name === 'ai_review')!;

    const approveRule = aiReviewMovement.rules!.find((r) => r.next === 'reviewers');
    expect(approveRule).toBeDefined();
  });

  it('should have ai_fix transitioning to ai_review movement', () => {
    const piece = getBuiltinPiece('default');
    const aiFixMovement = piece!.movements.find((s) => s.name === 'ai_fix')!;

    const fixedRule = aiFixMovement.rules!.find((r) => r.next === 'ai_review');
    expect(fixedRule).toBeDefined();
  });

  it('should have fix movement transitioning back to reviewers', () => {
    const piece = getBuiltinPiece('default');
    const fixMovement = piece!.movements.find((s) => s.name === 'fix')!;

    const fixedRule = fixMovement.rules!.find((r) => r.next === 'reviewers');
    expect(fixedRule).toBeDefined();
  });

  it('should not have old separate review/security_review/improve movements', () => {
    const piece = getBuiltinPiece('default');
    const movementNames = piece!.movements.map((s) => s.name);

    expect(movementNames).not.toContain('review');
    expect(movementNames).not.toContain('security_review');
    expect(movementNames).not.toContain('improve');
    expect(movementNames).not.toContain('security_fix');
  });

  it('should have sub-movements with correct agents', () => {
    const piece = getBuiltinPiece('default');
    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersMovement.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.persona).toContain('architecture-reviewer');

    const qaReview = reviewersMovement.parallel!.find((s) => s.name === 'qa-review')!;
    expect(qaReview.persona).toContain('qa-reviewer');
  });

  it('should have output contracts configured on sub-movements', () => {
    const piece = getBuiltinPiece('default');
    const reviewersMovement = piece!.movements.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersMovement.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.outputContracts).toBeDefined();

    const qaReview = reviewersMovement.parallel!.find((s) => s.name === 'qa-review')!;
    expect(qaReview.outputContracts).toBeDefined();
  });
});

describe('loadAllPieces', () => {
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

  it('should load project-local pieces when cwd is provided', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    const samplePiece = `
name: test-piece
description: Test piece
max_movements: 10
movements:
  - name: step1
    persona: coder
    instruction: "{task}"
    rules:
      - condition: Task completed
        next: COMPLETE
`;
    writeFileSync(join(piecesDir, 'test.yaml'), samplePiece);

    const pieces = loadAllPieces(testDir);

    expect(pieces.has('test')).toBe(true);
  });
});

describe('loadPiece (builtin fallback)', () => {
  it('should load builtin piece when user piece does not exist', () => {
    const piece = loadPiece('default', process.cwd());
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('default');
  });

  it('should return null for non-existent piece', () => {
    const piece = loadPiece('does-not-exist', process.cwd());
    expect(piece).toBeNull();
  });

  it('should load builtin pieces like minimal, research, e2e-test', () => {
    const minimal = loadPiece('minimal', process.cwd());
    expect(minimal).not.toBeNull();
    expect(minimal!.name).toBe('minimal');

    const research = loadPiece('research', process.cwd());
    expect(research).not.toBeNull();
    expect(research!.name).toBe('research');

    const e2eTest = loadPiece('e2e-test', process.cwd());
    expect(e2eTest).not.toBeNull();
    expect(e2eTest!.name).toBe('e2e-test');
  });
});

describe('listPieces (builtin fallback)', () => {
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

  it('should include builtin pieces', () => {
    const pieces = listPieces(testDir);
    expect(pieces).toContain('default');
    expect(pieces).toContain('minimal');
    expect(pieces).toContain('e2e-test');
  });

  it('should return sorted list', () => {
    const pieces = listPieces(testDir);
    const sorted = [...pieces].sort();
    expect(pieces).toEqual(sorted);
  });
});

describe('loadAllPieces (builtin fallback)', () => {
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

  it('should include builtin pieces in the map', () => {
    const pieces = loadAllPieces(testDir);
    expect(pieces.has('default')).toBe(true);
    expect(pieces.has('minimal')).toBe(true);
  });
});

describe('loadPersonaPromptFromPath (builtin paths)', () => {
  it('should load persona prompt from builtin resources path', () => {
    const lang = getLanguage();
    const builtinPersonasDir = getBuiltinPersonasDir(lang);
    const personaPath = join(builtinPersonasDir, 'coder.md');

    if (existsSync(personaPath)) {
      const prompt = loadPersonaPromptFromPath(personaPath);
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
    }
  });
});

describe('getCurrentPiece', () => {
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
    const piece = getCurrentPiece(testDir);

    expect(piece).toBe('default');
  });

  it('should return saved piece name from config.yaml', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'piece: default\n');

    const piece = getCurrentPiece(testDir);

    expect(piece).toBe('default');
  });

  it('should return default for empty config', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), '');

    const piece = getCurrentPiece(testDir);

    expect(piece).toBe('default');
  });
});

describe('setCurrentPiece', () => {
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

  it('should save piece name to config.yaml', () => {
    setCurrentPiece(testDir, 'my-piece');

    const config = loadProjectConfig(testDir);

    expect(config.piece).toBe('my-piece');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    setCurrentPiece(testDir, 'test');

    expect(existsSync(configDir)).toBe(true);
  });

  it('should overwrite existing piece name', () => {
    setCurrentPiece(testDir, 'first');
    setCurrentPiece(testDir, 'second');

    const piece = getCurrentPiece(testDir);

    expect(piece).toBe('second');
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
    setCurrentPiece(testDir, 'test');

    const configDir = getProjectConfigDir(testDir);
    const gitignorePath = join(configDir, '.gitignore');

    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should copy .gitignore to existing config directory without one', () => {
    // Create config directory without .gitignore
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'piece: existing\n');

    // Save config should still copy .gitignore
    setCurrentPiece(testDir, 'updated');

    const gitignorePath = join(configDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should not overwrite existing .gitignore', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const customContent = '# Custom gitignore\nmy-custom-file';
    writeFileSync(join(configDir, '.gitignore'), customContent);

    setCurrentPiece(testDir, 'test');

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
      personaSessions: { coder: 'session-123', reviewer: 'session-456' },
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

  describe('loadPersonaSessions with provider', () => {
    it('should return sessions when provider matches', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadPersonaSessions(testDir, 'claude');
      expect(sessions.coder).toBe('session-1');
    });

    it('should return empty when provider has changed', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadPersonaSessions(testDir, 'codex');
      expect(sessions).toEqual({});
    });

    it('should return sessions when no provider is specified (legacy)', () => {
      updatePersonaSession(testDir, 'coder', 'session-1');

      const sessions = loadPersonaSessions(testDir);
      expect(sessions.coder).toBe('session-1');
    });
  });

  describe('updatePersonaSession with provider', () => {
    it('should discard old sessions when provider changes', () => {
      updatePersonaSession(testDir, 'coder', 'claude-session', 'claude');
      updatePersonaSession(testDir, 'coder', 'codex-session', 'codex');

      const sessions = loadPersonaSessions(testDir, 'codex');
      expect(sessions.coder).toBe('codex-session');
      // Old claude sessions should not remain
      expect(Object.keys(sessions)).toHaveLength(1);
    });

    it('should store provider in session data', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const path = getPersonaSessionsPath(testDir);
      const data = JSON.parse(readFileSync(path, 'utf-8')) as PersonaSessionData;
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
      const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as PersonaSessionData;
      expect(data.provider).toBe('claude');
    });
  });
});
