/**
 * Piece loader integration tests.
 *
 * Tests the 3-tier piece resolution (project-local → user → builtin)
 * and YAML parsing including special rule syntax (ai(), all(), any()).
 *
 * Mocked: globalConfig (for language/builtins)
 * Not mocked: loadPiece, parsePiece, rule parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mocks ---
const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn(() => languageState.value),
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

// --- Imports (after mocks) ---

import { loadPiece } from '../infra/config/index.js';
import { listBuiltinPieceNames } from '../infra/config/loaders/pieceResolver.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfl-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Piece Loader IT: builtin piece loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const builtinNames = listBuiltinPieceNames({ includeDisabled: true });

  for (const name of builtinNames) {
    it(`should load builtin piece: ${name}`, () => {
      const config = loadPiece(name, testDir);

      expect(config).not.toBeNull();
      expect(config!.name).toBe(name);
      expect(config!.movements.length).toBeGreaterThan(0);
      expect(config!.initialMovement).toBeDefined();
      expect(config!.maxMovements).toBeGreaterThan(0);
    });
  }

  it('should return null for non-existent piece', () => {
    const config = loadPiece('non-existent-piece-xyz', testDir);
    expect(config).toBeNull();
  });

  it('should include and load e2e-test as a builtin piece', () => {
    expect(builtinNames).toContain('e2e-test');

    const config = loadPiece('e2e-test', testDir);
    expect(config).not.toBeNull();

    const planMovement = config!.movements.find((movement) => movement.name === 'plan_test');
    const implementMovement = config!.movements.find((movement) => movement.name === 'implement_test');

    expect(planMovement).toBeDefined();
    expect(implementMovement).toBeDefined();
    expect(planMovement!.instructionTemplate).toContain('missing E2E tests');
    expect(implementMovement!.instructionTemplate).toContain('npm run test:e2e:mock');
  });

  it('should load e2e-test as a builtin piece in ja locale', () => {
    languageState.value = 'ja';

    const jaBuiltinNames = listBuiltinPieceNames({ includeDisabled: true });
    expect(jaBuiltinNames).toContain('e2e-test');

    const config = loadPiece('e2e-test', testDir);
    expect(config).not.toBeNull();

    const planMovement = config!.movements.find((movement) => movement.name === 'plan_test');
    const implementMovement = config!.movements.find((movement) => movement.name === 'implement_test');

    expect(planMovement).toBeDefined();
    expect(implementMovement).toBeDefined();
    expect(planMovement!.instructionTemplate).toContain('E2Eテスト');
    expect(implementMovement!.instructionTemplate).toContain('npm run test:e2e:mock');
  });
});

describe('Piece Loader IT: project-local piece override', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load project-local piece from .takt/pieces/', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    const agentsDir = join(testDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'custom.md'), 'Custom agent');

    writeFileSync(join(piecesDir, 'custom-wf.yaml'), `
name: custom-wf
description: Custom project piece
max_movements: 5
initial_movement: start

movements:
  - name: start
    persona: ./agents/custom.md
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Do the work"
`);

    const config = loadPiece('custom-wf', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('custom-wf');
    expect(config!.movements.length).toBe(1);
    expect(config!.movements[0]!.name).toBe('start');
  });
});

describe('Piece Loader IT: agent path resolution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve relative agent paths from piece YAML location', () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();

    for (const movement of config!.movements) {
      if (movement.personaPath) {
        // Agent paths should be resolved to absolute paths
        expect(movement.personaPath).toMatch(/^\//);
        // Agent files should exist
        expect(existsSync(movement.personaPath)).toBe(true);
      }
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          if (sub.personaPath) {
            expect(sub.personaPath).toMatch(/^\//);
            expect(existsSync(sub.personaPath)).toBe(true);
          }
        }
      }
    }
  });
});

describe('Piece Loader IT: rule syntax parsing', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse all() aggregate conditions from default piece', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    // Find the parallel reviewers movement
    const reviewersStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(reviewersStep).toBeDefined();

    // Should have aggregate rules
    const allRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'all',
    );
    expect(allRule).toBeDefined();
    expect(allRule!.aggregateConditionText).toBe('approved');
  });

  it('should parse any() aggregate conditions from default piece', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    const reviewersStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length > 0,
    );

    const anyRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'any',
    );
    expect(anyRule).toBeDefined();
    expect(anyRule!.aggregateConditionText).toBe('needs_fix');
  });

  it('should parse standard rules with next movement', () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();

    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.rules).toBeDefined();
    expect(implementStep!.rules!.length).toBeGreaterThan(0);

    // Each rule should have condition and next
    for (const rule of implementStep!.rules!) {
      expect(typeof rule.condition).toBe('string');
      expect(rule.condition.length).toBeGreaterThan(0);
    }
  });
});

describe('Piece Loader IT: piece config validation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should set max_movements from YAML', () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.maxMovements).toBe('number');
    expect(config!.maxMovements).toBeGreaterThan(0);
  });

  it('should set initial_movement from YAML', () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.initialMovement).toBe('string');

    // initial_movement should reference an existing movement
    const movementNames = config!.movements.map((s) => s.name);
    expect(movementNames).toContain(config!.initialMovement);
  });

  it('should preserve edit property on movements (review-only has no edit: true)', () => {
    const config = loadPiece('review-only', testDir);
    expect(config).not.toBeNull();

    // review-only: no movement should have edit: true
    for (const movement of config!.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }

    // expert: implement movement should have edit: true
    const expertConfig = loadPiece('expert', testDir);
    expect(expertConfig).not.toBeNull();
    const implementStep = expertConfig!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.edit).toBe(true);
  });

  it('should set passPreviousResponse from YAML', () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();

    // At least some movements should have passPreviousResponse set
    const movementsWithPassPrev = config!.movements.filter((s) => s.passPreviousResponse === true);
    expect(movementsWithPassPrev.length).toBeGreaterThan(0);
  });
});

describe('Piece Loader IT: parallel movement loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load parallel sub-movements from default piece', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    const parallelStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(parallelStep).toBeDefined();
    expect(parallelStep!.parallel!.length).toBeGreaterThanOrEqual(2);

    // Each sub-movement should have required fields
    for (const sub of parallelStep!.parallel!) {
      expect(sub.name).toBeDefined();
      expect(sub.persona).toBeDefined();
      expect(sub.rules).toBeDefined();
    }
  });

  it('should load 4 parallel reviewers from expert piece', () => {
    const config = loadPiece('expert', testDir);
    expect(config).not.toBeNull();

    const parallelStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length === 4,
    );
    expect(parallelStep).toBeDefined();

    const subNames = parallelStep!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
  });
});

describe('Piece Loader IT: report config loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load single report config', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    // default piece: plan movement has output contracts
    const planStep = config!.movements.find((s) => s.name === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.outputContracts).toBeDefined();
  });

  it('should load multi-report config from expert piece', () => {
    const config = loadPiece('expert', testDir);
    expect(config).not.toBeNull();

    // implement movement has multi-output contracts: [Scope, Decisions]
    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.outputContracts).toBeDefined();
    expect(Array.isArray(implementStep!.outputContracts)).toBe(true);
    expect((implementStep!.outputContracts as unknown[]).length).toBe(2);
  });
});

describe('Piece Loader IT: quality_gates loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse quality_gates from YAML', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'with-gates.yaml'), `
name: with-gates
description: Piece with quality gates
max_movements: 5
initial_movement: implement

movements:
  - name: implement
    persona: coder
    edit: true
    quality_gates:
      - "All tests must pass"
      - "No TypeScript errors"
      - "Coverage must be above 80%"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadPiece('with-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toBeDefined();
    expect(implementStep!.qualityGates).toEqual([
      'All tests must pass',
      'No TypeScript errors',
      'Coverage must be above 80%',
    ]);
  });

  it('should allow movement without quality_gates', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'no-gates.yaml'), `
name: no-gates
description: Piece without quality gates
max_movements: 5
initial_movement: implement

movements:
  - name: implement
    persona: coder
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadPiece('no-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toBeUndefined();
  });

  it('should allow empty quality_gates array', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'empty-gates.yaml'), `
name: empty-gates
description: Piece with empty quality gates
max_movements: 5
initial_movement: implement

movements:
  - name: implement
    persona: coder
    quality_gates: []
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadPiece('empty-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toEqual([]);
  });
});

describe('Piece Loader IT: mcp_servers parsing', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse mcp_servers from YAML to PieceMovement.mcpServers', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'with-mcp.yaml'), `
name: with-mcp
description: Piece with MCP servers
max_movements: 5
initial_movement: e2e-test

movements:
  - name: e2e-test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    allowed_tools:
      - Read
      - Bash
      - mcp__playwright__*
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run E2E tests"
`);

    const config = loadPiece('with-mcp', testDir);

    expect(config).not.toBeNull();
    const e2eStep = config!.movements.find((s) => s.name === 'e2e-test');
    expect(e2eStep).toBeDefined();
    expect(e2eStep!.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should allow movement without mcp_servers', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'no-mcp.yaml'), `
name: no-mcp
description: Piece without MCP servers
max_movements: 5
initial_movement: implement

movements:
  - name: implement
    persona: coder
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadPiece('no-mcp', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.mcpServers).toBeUndefined();
  });

  it('should parse mcp_servers with multiple servers and transports', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'multi-mcp.yaml'), `
name: multi-mcp
description: Piece with multiple MCP servers
max_movements: 5
initial_movement: test

movements:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
      remote-api:
        type: http
        url: http://localhost:3000/mcp
        headers:
          Authorization: "Bearer token123"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    const config = loadPiece('multi-mcp', testDir);

    expect(config).not.toBeNull();
    const testStep = config!.movements.find((s) => s.name === 'test');
    expect(testStep).toBeDefined();
    expect(testStep!.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
      'remote-api': {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        headers: { Authorization: 'Bearer token123' },
      },
    });
  });
});

describe('Piece Loader IT: structural-reform piece', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load structural-reform with 7 movements', () => {
    const config = loadPiece('structural-reform', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('structural-reform');
    expect(config!.movements.length).toBe(7);
    expect(config!.maxMovements).toBe(50);
    expect(config!.initialMovement).toBe('review');
  });

  it('should have expected movement names in order', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const movementNames = config!.movements.map((m) => m.name);
    expect(movementNames).toEqual([
      'review',
      'plan_reform',
      'implement',
      'reviewers',
      'fix',
      'verify',
      'next_target',
    ]);
  });

  it('should have review as read-only with instruction_template', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const review = config!.movements.find((m) => m.name === 'review');
    expect(review).toBeDefined();
    expect(review!.edit).not.toBe(true);
    expect(review!.instructionTemplate).toBeDefined();
    expect(review!.instructionTemplate).toContain('{task}');
  });

  it('should have implement with edit: true and session: refresh', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const implement = config!.movements.find((m) => m.name === 'implement');
    expect(implement).toBeDefined();
    expect(implement!.edit).toBe(true);
    expect(implement!.session).toBe('refresh');
  });

  it('should have 2 parallel reviewers (arch-review and qa-review)', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const reviewers = config!.movements.find(
      (m) => m.parallel && m.parallel.length > 0,
    );
    expect(reviewers).toBeDefined();
    expect(reviewers!.parallel!.length).toBe(2);

    const subNames = reviewers!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('qa-review');
  });

  it('should have aggregate rules on reviewers movement', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const reviewers = config!.movements.find(
      (m) => m.parallel && m.parallel.length > 0,
    );
    expect(reviewers).toBeDefined();

    const allRule = reviewers!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'all',
    );
    expect(allRule).toBeDefined();
    expect(allRule!.aggregateConditionText).toBe('approved');
    expect(allRule!.next).toBe('verify');

    const anyRule = reviewers!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'any',
    );
    expect(anyRule).toBeDefined();
    expect(anyRule!.aggregateConditionText).toBe('needs_fix');
    expect(anyRule!.next).toBe('fix');
  });

  it('should have verify movement with instruction_template', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const verify = config!.movements.find((m) => m.name === 'verify');
    expect(verify).toBeDefined();
    expect(verify!.edit).not.toBe(true);
    expect(verify!.instructionTemplate).toBeDefined();
  });

  it('should have next_target movement routing to implement or COMPLETE', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();

    const nextTarget = config!.movements.find((m) => m.name === 'next_target');
    expect(nextTarget).toBeDefined();
    expect(nextTarget!.edit).not.toBe(true);

    const nextValues = nextTarget!.rules?.map((r) => r.next);
    expect(nextValues).toContain('implement');
    expect(nextValues).toContain('COMPLETE');
  });

  it('should have loop_monitors for implement-fix cycle', () => {
    const config = loadPiece('structural-reform', testDir);
    expect(config).not.toBeNull();
    expect(config!.loopMonitors).toBeDefined();
    expect(config!.loopMonitors!.length).toBe(1);

    const monitor = config!.loopMonitors![0]!;
    expect(monitor.cycle).toEqual(['implement', 'fix']);
    expect(monitor.threshold).toBe(3);
    expect(monitor.judge).toBeDefined();
  });
});

describe('Piece Loader IT: invalid YAML handling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should throw for piece file with invalid YAML', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'broken.yaml'), `
name: broken
this is not: valid yaml: [[[[
  - bad: {
`);

    expect(() => loadPiece('broken', testDir)).toThrow();
  });

  it('should throw for piece missing required fields', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'incomplete.yaml'), `
name: incomplete
description: Missing movements
`);

    expect(() => loadPiece('incomplete', testDir)).toThrow();
  });
});
