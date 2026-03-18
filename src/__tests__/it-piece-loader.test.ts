/**
 * Piece loader integration tests.
 *
 * Tests the 3-tier piece resolution (project-local → user → builtin)
 * and YAML parsing including special rule syntax (ai(), all(), any()).
 *
 * Mocked: loadConfig (for language/builtins)
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
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

// --- Imports (after mocks) ---

import { loadPiece } from '../infra/config/index.js';
import { listBuiltinPieceNames } from '../infra/config/loaders/pieceResolver.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfl-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Piece Loader IT: builtin piece loading', () => {
  let testDir: string;
  const builtinNames = listBuiltinPieceNames(process.cwd(), { includeDisabled: true });

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

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

  it('should include and load fill-e2e as a builtin piece', () => {
    expect(builtinNames).toContain('fill-e2e');

    const config = loadPiece('fill-e2e', testDir);
    expect(config).not.toBeNull();

    const planMovement = config!.movements.find((movement) => movement.name === 'plan_test');
    const implementMovement = config!.movements.find((movement) => movement.name === 'implement_test');

    expect(planMovement).toBeDefined();
    expect(implementMovement).toBeDefined();
  });

  it('should load fill-e2e as a builtin piece in ja locale', () => {
    languageState.value = 'ja';

    const jaBuiltinNames = listBuiltinPieceNames(testDir, { includeDisabled: true });
    expect(jaBuiltinNames).toContain('fill-e2e');

    const config = loadPiece('fill-e2e', testDir);
    expect(config).not.toBeNull();

    const planMovement = config!.movements.find((movement) => movement.name === 'plan_test');
    const implementMovement = config!.movements.find((movement) => movement.name === 'implement_test');

    expect(planMovement).toBeDefined();
    expect(implementMovement).toBeDefined();
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

  it('should propagate canonical instruction field through loader for movement and loop monitor judge', () => {
    // Given: project-local piece that uses instruction on both movement and loop monitor judge
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'instruction-canonical.yaml'), `
name: instruction-canonical
max_movements: 8
initial_movement: step1

movements:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    // When: loading the piece through the integration entry point
    const config = loadPiece('instruction-canonical', testDir);

    // Then: canonical instruction is available on normalized movement/judge models
    expect(config).not.toBeNull();
    const step1 = config!.movements[0] as unknown as Record<string, unknown>;
    const judge = config!.loopMonitors?.[0]?.judge as unknown as Record<string, unknown>;
    expect(step1.instruction).toBe('Step 1 instruction');
    expect(judge.instruction).toBe('Judge instruction');
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
    const config = loadPiece('default', testDir);
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

  it('should parse all() multi-condition aggregate from default piece', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    // Find the parallel reviewers movement
    const reviewersStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(reviewersStep).toBeDefined();

    // Should have aggregate rules with multi-condition (array)
    const allRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'all',
    );
    expect(allRule).toBeDefined();
    // Multi-condition aggregate: all("approved", "All checks passed")
    expect(Array.isArray(allRule!.aggregateConditionText)).toBe(true);
    expect((allRule!.aggregateConditionText as string[])[0]).toBe('approved');
  });

  it('should parse any() multi-condition aggregate from default piece', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    const reviewersStep = config!.movements.find(
      (s) => s.parallel && s.parallel.length > 0,
    );

    const anyRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'any',
    );
    expect(anyRule).toBeDefined();
    // Multi-condition aggregate: any("needs_fix", "...")
    expect(Array.isArray(anyRule!.aggregateConditionText)).toBe(true);
    expect((anyRule!.aggregateConditionText as string[])[0]).toBe('needs_fix');
  });

  it('should parse standard rules with next movement', () => {
    const config = loadPiece('default', testDir);
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
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.maxMovements).toBe('number');
    expect(config!.maxMovements).toBeGreaterThan(0);
  });

  it('should set initial_movement from YAML', () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.initialMovement).toBe('string');

    // initial_movement should reference an existing movement
    const movementNames = config!.movements.map((s) => s.name);
    expect(movementNames).toContain(config!.initialMovement);
  });

  it('should preserve edit property on movements (review has no edit: true)', () => {
    const config = loadPiece('review-default', testDir);
    expect(config).not.toBeNull();

    // review: no movement should have edit: true
    for (const movement of config!.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }

    // dual: implement movement should have edit: true
    const dualConfig = loadPiece('dual', testDir);
    expect(dualConfig).not.toBeNull();
    const implementStep = dualConfig!.movements.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.edit).toBe(true);
  });

  it('should set passPreviousResponse from YAML', () => {
    const config = loadPiece('default', testDir);
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

  it('should load 2-stage parallel reviewers from dual piece', () => {
    const config = loadPiece('dual', testDir);
    expect(config).not.toBeNull();

    const reviewers1 = config!.movements.find((s) => s.name === 'reviewers_1');
    expect(reviewers1).toBeDefined();
    expect(reviewers1!.parallel!.length).toBe(3);
    const stage1Names = reviewers1!.parallel!.map((s) => s.name);
    expect(stage1Names).toContain('arch-review');
    expect(stage1Names).toContain('frontend-review');
    expect(stage1Names).toContain('testing-review');

    const reviewers2 = config!.movements.find((s) => s.name === 'reviewers_2');
    expect(reviewers2).toBeDefined();
    expect(reviewers2!.parallel!.length).toBe(3);
    const stage2Names = reviewers2!.parallel!.map((s) => s.name);
    expect(stage2Names).toContain('security-review');
    expect(stage2Names).toContain('qa-review');
    expect(stage2Names).toContain('requirements-review');
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

  it('should load multi-report config from dual piece', () => {
    const config = loadPiece('dual', testDir);
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
    provider_options:
      claude:
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

describe('Piece Loader IT: piece runtime.prepare policy', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects piece runtime.prepare custom scripts by default', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'runtime-custom.yaml'), `
name: runtime-custom
piece_config:
  runtime:
    prepare:
      - ./setup.sh
movements:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadPiece('runtime-custom', testDir)).toThrow(/piece_runtime_prepare\.custom_scripts/);
  });

  it('allows piece runtime.prepare gradle preset by default', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'runtime-gradle.yaml'), `
name: runtime-gradle
piece_config:
  runtime:
    prepare:
      - gradle
movements:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadPiece('runtime-gradle', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['gradle'] });
  });

  it('allows piece runtime.prepare node preset by default', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(piecesDir, 'runtime-node.yaml'), `
name: runtime-node
piece_config:
  runtime:
    prepare:
      - node
movements:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadPiece('runtime-node', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['node'] });
  });

  it('allows piece runtime.prepare custom scripts when project config enables them', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });

    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'piece_runtime_prepare:\n  custom_scripts: true\n');
    writeFileSync(join(piecesDir, 'runtime-custom.yaml'), `
name: runtime-custom
piece_config:
  runtime:
    prepare:
      - ./setup.sh
movements:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadPiece('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('rejects piece runtime.prepare custom scripts when global allows and project explicitly denies', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      pieceRuntimePrepare: { customScripts: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'piece_runtime_prepare:\n  custom_scripts: false\n',
    );
    writeFileSync(join(piecesDir, 'runtime-custom.yaml'), `
name: runtime-custom
piece_config:
  runtime:
    prepare:
      - ./setup.sh
movements:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadPiece('runtime-custom', testDir)).toThrow(/piece_runtime_prepare\.custom_scripts/);
  });

  it('allows piece runtime.prepare custom scripts when global denies and project explicitly allows', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      pieceRuntimePrepare: { customScripts: false },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'piece_runtime_prepare:\n  custom_scripts: true\n',
    );
    writeFileSync(join(piecesDir, 'runtime-custom.yaml'), `
name: runtime-custom
piece_config:
  runtime:
    prepare:
      - ./setup.sh
movements:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadPiece('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('preserves globally allowed runtime.prepare custom scripts when project config sets the policy block', () => {
    const piecesDir = join(testDir, '.takt', 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      pieceRuntimePrepare: { customScripts: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'piece_runtime_prepare: {}\n');
    writeFileSync(join(piecesDir, 'runtime-custom.yaml'), `
name: runtime-custom
piece_config:
  runtime:
    prepare:
      - ./setup.sh
movements:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadPiece('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });
});
