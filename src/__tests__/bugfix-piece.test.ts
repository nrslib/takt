import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PieceConfigRawSchema } from '../core/models/index.js';

const RESOURCES_DIR = join(import.meta.dirname, '../../builtins');

type Rule = {
  condition: string;
  next?: string;
};

type Movement = {
  name: string;
  persona?: string;
  instruction?: string;
  rules?: Rule[];
  output_contracts?: {
    report?: Array<{
      name?: string;
      format?: string;
      Validation?: string;
      Summary?: string;
    }>;
  };
};

type LoopMonitor = {
  cycle: string[];
  threshold: number;
};

type RawPiece = {
  name: string;
  initial_movement: string;
  max_movements: number;
  movements: Movement[];
  loop_monitors?: LoopMonitor[];
};

function loadYaml<T>(path: string): T {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as T;
}

function loadBugfixPiece(lang: 'en' | 'ja'): RawPiece {
  return loadYaml<RawPiece>(join(RESOURCES_DIR, lang, 'pieces', 'bugfix.yaml'));
}

function getMovement(piece: RawPiece, name: string): Movement {
  const movement = piece.movements.find((entry) => entry.name === name);
  expect(movement).toBeDefined();
  return movement as Movement;
}

describe('bugfix piece (EN/JA)', () => {
  it('should pass schema validation for both languages', () => {
    const enRaw = loadBugfixPiece('en');
    const jaRaw = loadBugfixPiece('ja');

    expect(PieceConfigRawSchema.safeParse(enRaw).success).toBe(true);
    expect(PieceConfigRawSchema.safeParse(jaRaw).success).toBe(true);
  });

  it('should have the expected workflow structure', () => {
    const enRaw = loadBugfixPiece('en');
    const jaRaw = loadBugfixPiece('ja');

    expect(enRaw.name).toBe('bugfix');
    expect(jaRaw.name).toBe('bugfix');
    expect(enRaw.initial_movement).toBe('analyze');
    expect(jaRaw.initial_movement).toBe('analyze');
    expect(enRaw.max_movements).toBe(15);
    expect(jaRaw.max_movements).toBe(15);
    expect(enRaw.movements.map((movement) => movement.name)).toEqual(['analyze', 'fix', 'verify']);
    expect(jaRaw.movements.map((movement) => movement.name)).toEqual(['analyze', 'fix', 'verify']);
  });

  it('should configure fix-verify loop monitor', () => {
    const enRaw = loadBugfixPiece('en');
    const jaRaw = loadBugfixPiece('ja');

    expect(enRaw.loop_monitors).toHaveLength(1);
    expect(jaRaw.loop_monitors).toHaveLength(1);
    expect(enRaw.loop_monitors?.[0]?.cycle).toEqual(['fix', 'verify']);
    expect(jaRaw.loop_monitors?.[0]?.cycle).toEqual(['fix', 'verify']);
    expect(enRaw.loop_monitors?.[0]?.threshold).toBe(3);
    expect(jaRaw.loop_monitors?.[0]?.threshold).toBe(3);
  });

  it('should route analyze to fix or ABORT, and fix to verify', () => {
    const enRaw = loadBugfixPiece('en');
    const jaRaw = loadBugfixPiece('ja');

    const enAnalyze = getMovement(enRaw, 'analyze');
    const jaAnalyze = getMovement(jaRaw, 'analyze');
    const fix = getMovement(enRaw, 'fix');

    expect(enAnalyze.persona).toBe('bugfix-analyst');
    expect(enAnalyze.instruction).toBe('analyze-bug');
    expect(enAnalyze.rules?.some((rule) => rule.next === 'fix')).toBe(true);
    expect(enAnalyze.rules?.some((rule) => rule.next === 'ABORT')).toBe(true);
    expect(jaAnalyze.rules?.some((rule) => rule.next === 'ABORT')).toBe(true);
    expect(fix.rules?.some((rule) => rule.next === 'verify')).toBe(true);
    expect(fix.rules?.some((rule) => rule.next === 'analyze')).toBe(true);
  });

  it('should configure verify movement with supervisor contract outputs', () => {
    const enRaw = loadBugfixPiece('en');
    const verify = getMovement(enRaw, 'verify');

    expect(verify.persona).toBe('supervisor');
    expect(verify.instruction).toBe('supervise');
    expect(verify.rules?.some((rule) => rule.next === 'COMPLETE')).toBe(true);
    expect(verify.rules?.some((rule) => rule.next === 'fix')).toBe(true);

    const reportEntries = verify.output_contracts?.report ?? [];
    expect(reportEntries.some((entry) => entry.Validation === '02-verification.md')).toBe(true);
    expect(reportEntries.some((entry) => entry.Summary === 'summary.md')).toBe(true);
  });
});

describe('bugfix facet files', () => {
  it('should include bugfix in quick start categories for EN/JA', () => {
    const enCategories = loadYaml<{ piece_categories: Record<string, { pieces?: string[] }> }>(
      join(RESOURCES_DIR, 'en', 'piece-categories.yaml'),
    );
    const jaCategories = loadYaml<{ piece_categories: Record<string, { pieces?: string[] }> }>(
      join(RESOURCES_DIR, 'ja', 'piece-categories.yaml'),
    );

    expect(enCategories.piece_categories['🚀 Quick Start']?.pieces).toContain('bugfix');
    expect(jaCategories.piece_categories['🚀 クイックスタート']?.pieces).toContain('bugfix');
  });

  it('should provide analyze instruction, persona, and output contract in both languages', () => {
    const enInstruction = readFileSync(join(RESOURCES_DIR, 'en', 'instructions', 'analyze-bug.md'), 'utf-8');
    const jaInstruction = readFileSync(join(RESOURCES_DIR, 'ja', 'instructions', 'analyze-bug.md'), 'utf-8');
    const enPersona = readFileSync(join(RESOURCES_DIR, 'en', 'personas', 'bugfix-analyst.md'), 'utf-8');
    const jaPersona = readFileSync(join(RESOURCES_DIR, 'ja', 'personas', 'bugfix-analyst.md'), 'utf-8');
    const enContract = readFileSync(join(RESOURCES_DIR, 'en', 'output-contracts', 'bug-analysis.md'), 'utf-8');
    const jaContract = readFileSync(join(RESOURCES_DIR, 'ja', 'output-contracts', 'bug-analysis.md'), 'utf-8');

    expect(enInstruction).toContain('Analyze the reported bug');
    expect(jaInstruction).toContain('報告されたバグを分析');
    expect(enPersona).toContain('# Bugfix Analyst');
    expect(jaPersona).toContain('# Bugfix Analyst');
    expect(enContract).toContain('# Bug Analysis');
    expect(jaContract).toContain('# バグ分析');
  });
});
