/**
 * Tests for review-default builtin workflow
 *
 * Covers:
 * - Workflow YAML files (EN/JA) load and pass schema validation
 * - Step structure: gather -> reviewers (parallel 5) -> supervise -> COMPLETE
 * - All steps have edit: false
 * - All 5 reviewers have Bash in provider_options.claude.allowed_tools
 * - Routing rules for gather and reviewers
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PieceConfigRawSchema } from '../core/models/index.js';

const RESOURCES_DIR = join(import.meta.dirname, '../../builtins');

function loadReviewYaml(lang: 'en' | 'ja') {
  const filePath = join(RESOURCES_DIR, lang, 'workflows', 'review-default.yaml');
  const content = readFileSync(filePath, 'utf-8');
  return parseYaml(content);
}

describe('review-default workflow (EN)', () => {
  const raw = loadReviewYaml('en') as {
    name: string;
    initial_step: string;
    max_steps: number;
    steps: Array<{
      name: string;
      edit?: boolean;
      persona?: string;
      parallel?: Array<{ name: string; edit?: boolean; provider_options?: { claude?: { allowed_tools?: string[] } } }>;
      rules?: Array<{ condition: string; next?: string }>;
      output_contracts?: { report: Array<{ name: string }> };
    }>;
  };

  it('should pass schema validation', () => {
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_step', () => {
    expect(raw.name).toBe('review-default');
    expect(raw.initial_step).toBe('gather');
  });

  it('should have max_steps of 10', () => {
    expect(raw.max_steps).toBe(10);
  });

  it('should have 3 steps: gather, reviewers, supervise', () => {
    const stepNames = raw.steps.map((s) => s.name);
    expect(stepNames).toEqual(['gather', 'reviewers', 'supervise']);
  });

  it('should have all steps with edit: false', () => {
    for (const step of raw.steps) {
      if (step.edit !== undefined) {
        expect(step.edit).toBe(false);
      }
      if (step.parallel) {
        for (const sub of step.parallel) {
          if (sub.edit !== undefined) {
            expect(sub.edit).toBe(false);
          }
        }
      }
    }
  });

  it('should have reviewers step with 5 parallel sub-steps', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers.parallel).toHaveLength(5);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual([
      'arch-review',
      'security-review',
      'qa-review',
      'testing-review',
      'requirements-review',
    ]);
  });

  it('should have reviewers step with aggregate rules', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    expect(reviewers.rules).toHaveLength(2);
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[0].next).toBe('supervise');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
    expect(reviewers.rules[1].next).toBe('supervise');
  });

  it('should have supervise step with single rule to COMPLETE', () => {
    const supervise = raw.steps.find((s) => s.name === 'supervise');
    expect(supervise.rules).toHaveLength(1);
    expect(supervise.rules[0].condition).toBe('Review synthesis complete');
    expect(supervise.rules[0].next).toBe('COMPLETE');
  });

  it('should have gather step using planner persona', () => {
    const gather = raw.steps.find((s) => s.name === 'gather');
    expect(gather.persona).toBe('planner');
  });

  it('should have supervise step using supervisor persona', () => {
    const supervise = raw.steps.find((s) => s.name === 'supervise');
    expect(supervise.persona).toBe('supervisor');
  });

  it('should not have any step with edit: true', () => {
    for (const step of raw.steps) {
      expect(step.edit).not.toBe(true);
      if (step.parallel) {
        for (const sub of step.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('should have Bash in provider_options.claude.allowed_tools for all 5 reviewers', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    for (const sub of reviewers.parallel) {
      expect(sub.provider_options?.claude?.allowed_tools).toContain('Bash');
    }
  });

  it('should have gather step with output_contracts for review target', () => {
    const gather = raw.steps.find((s) => s.name === 'gather');
    expect(gather.output_contracts).toBeDefined();
    expect(gather.output_contracts.report[0].name).toBe('review-target.md');
  });
});

describe('review-default workflow (JA)', () => {
  const raw = loadReviewYaml('ja') as {
    name: string;
    initial_step: string;
    steps: Array<{
      name: string;
      edit?: boolean;
      parallel?: Array<{ name: string; edit?: boolean; provider_options?: { claude?: { allowed_tools?: string[] } } }>;
      rules?: Array<{ condition: string; next?: string }>;
    }>;
  };

  it('should pass schema validation', () => {
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_step', () => {
    expect(raw.name).toBe('review-default');
    expect(raw.initial_step).toBe('gather');
  });

  it('should have same step structure as EN version', () => {
    const stepNames = raw.steps.map((s) => s.name);
    expect(stepNames).toEqual(['gather', 'reviewers', 'supervise']);
  });

  it('should have reviewers step with 5 parallel sub-steps', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    expect(reviewers.parallel).toHaveLength(5);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual([
      'arch-review',
      'security-review',
      'qa-review',
      'testing-review',
      'requirements-review',
    ]);
  });

  it('should have all steps with edit: false or undefined', () => {
    for (const step of raw.steps) {
      expect(step.edit).not.toBe(true);
      if (step.parallel) {
        for (const sub of step.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('should have Bash in provider_options.claude.allowed_tools for all 5 reviewers', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    for (const sub of reviewers.parallel) {
      expect(sub.provider_options?.claude?.allowed_tools).toContain('Bash');
    }
  });

  it('should have same aggregate rules on reviewers', () => {
    const reviewers = raw.steps.find((s) => s.name === 'reviewers');
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
  });
});
