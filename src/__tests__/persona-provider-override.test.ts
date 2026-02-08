/**
 * Tests for persona-level provider/model override (#156).
 *
 * Covers:
 * - PersonaDefinitionSchema validation (string and object formats)
 * - normalizePersonas() conversion
 * - normalizePieceConfig() merging persona provider/model into movements
 * - Priority: movement.provider > persona.provider
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PieceConfigRawSchema, PersonaDefinitionSchema } from '../core/models/schemas.js';
import { normalizePieceConfig, normalizePersonas } from '../infra/config/loaders/pieceParser.js';

describe('PersonaDefinitionSchema', () => {
  it('should accept a string value (path)', () => {
    const result = PersonaDefinitionSchema.parse('../personas/coder.md');
    expect(result).toBe('../personas/coder.md');
  });

  it('should accept an object with path only', () => {
    const result = PersonaDefinitionSchema.parse({ path: '../personas/coder.md' });
    expect(result).toEqual({ path: '../personas/coder.md' });
  });

  it('should accept an object with path and provider', () => {
    const result = PersonaDefinitionSchema.parse({
      path: '../personas/coder.md',
      provider: 'codex',
    });
    expect(result).toEqual({ path: '../personas/coder.md', provider: 'codex' });
  });

  it('should accept an object with path, provider, and model', () => {
    const result = PersonaDefinitionSchema.parse({
      path: '../personas/coder.md',
      provider: 'codex',
      model: 'gpt-5.2-codex',
    });
    expect(result).toEqual({
      path: '../personas/coder.md',
      provider: 'codex',
      model: 'gpt-5.2-codex',
    });
  });

  it('should reject an object without path', () => {
    expect(() => PersonaDefinitionSchema.parse({ provider: 'codex' })).toThrow();
  });

  it('should reject an invalid provider value', () => {
    expect(() =>
      PersonaDefinitionSchema.parse({
        path: '../personas/coder.md',
        provider: 'invalid',
      }),
    ).toThrow();
  });

  it('should accept all valid provider values', () => {
    for (const provider of ['claude', 'codex', 'mock'] as const) {
      const result = PersonaDefinitionSchema.parse({
        path: '../personas/coder.md',
        provider,
      });
      expect(result).toEqual({ path: '../personas/coder.md', provider });
    }
  });
});

describe('PieceConfigRawSchema with persona definitions', () => {
  it('should accept personas as string map (backward compatible)', () => {
    const raw = {
      name: 'test',
      personas: {
        coder: '../personas/coder.md',
        planner: '../personas/planner.md',
      },
      movements: [{ name: 'step1', instruction: '{task}' }],
    };
    const result = PieceConfigRawSchema.parse(raw);
    expect(result.personas).toEqual({
      coder: '../personas/coder.md',
      planner: '../personas/planner.md',
    });
  });

  it('should accept personas with mixed string and object formats', () => {
    const raw = {
      name: 'test',
      personas: {
        planner: '../personas/planner.md',
        coder: { path: '../personas/coder.md', provider: 'codex' },
      },
      movements: [{ name: 'step1', instruction: '{task}' }],
    };
    const result = PieceConfigRawSchema.parse(raw);
    expect(result.personas!['planner']).toBe('../personas/planner.md');
    expect(result.personas!['coder']).toEqual({
      path: '../personas/coder.md',
      provider: 'codex',
    });
  });
});

describe('normalizePersonas', () => {
  it('should return undefined for undefined input', () => {
    expect(normalizePersonas(undefined)).toBeUndefined();
  });

  it('should convert string format to PersonaDefinition', () => {
    const result = normalizePersonas({
      coder: '../personas/coder.md',
      planner: '../personas/planner.md',
    });
    expect(result).toEqual({
      coder: { path: '../personas/coder.md' },
      planner: { path: '../personas/planner.md' },
    });
  });

  it('should preserve object format with provider and model', () => {
    const result = normalizePersonas({
      coder: { path: '../personas/coder.md', provider: 'codex', model: 'gpt-5.2' },
    });
    expect(result).toEqual({
      coder: { path: '../personas/coder.md', provider: 'codex', model: 'gpt-5.2' },
    });
  });

  it('should handle mixed string and object formats', () => {
    const result = normalizePersonas({
      planner: '../personas/planner.md',
      coder: { path: '../personas/coder.md', provider: 'codex' },
    });
    expect(result).toEqual({
      planner: { path: '../personas/planner.md' },
      coder: { path: '../personas/coder.md', provider: 'codex' },
    });
  });

  it('should return undefined for empty record', () => {
    expect(normalizePersonas({})).toBeUndefined();
  });
});

describe('normalizePieceConfig persona provider merge', () => {
  let tempDir: string;
  let pieceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-persona-provider-test-'));
    pieceDir = join(tempDir, 'pieces');
    mkdirSync(pieceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should merge persona provider into movement when movement has no provider', () => {
    const personaFile = join(pieceDir, 'coder.md');
    writeFileSync(personaFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', provider: 'codex' },
      },
      movements: [
        { name: 'implement', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.provider).toBe('codex');
  });

  it('should merge persona model into movement when movement has no model', () => {
    const personaFile = join(pieceDir, 'coder.md');
    writeFileSync(personaFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', model: 'gpt-5.2-codex' },
      },
      movements: [
        { name: 'implement', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.model).toBe('gpt-5.2-codex');
  });

  it('should prefer movement provider over persona provider', () => {
    const personaFile = join(pieceDir, 'coder.md');
    writeFileSync(personaFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', provider: 'codex' },
      },
      movements: [
        { name: 'implement', persona: 'coder', provider: 'claude', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.provider).toBe('claude');
  });

  it('should prefer movement model over persona model', () => {
    const personaFile = join(pieceDir, 'coder.md');
    writeFileSync(personaFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', model: 'persona-model' },
      },
      movements: [
        { name: 'implement', persona: 'coder', model: 'movement-model', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.model).toBe('movement-model');
  });

  it('should not set provider/model when persona uses string format (no overrides)', () => {
    const personaFile = join(pieceDir, 'coder.md');
    writeFileSync(personaFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: './coder.md',
      },
      movements: [
        { name: 'implement', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.provider).toBeUndefined();
    expect(config.movements[0]!.model).toBeUndefined();
  });

  it('should apply persona provider to all movements referencing that persona', () => {
    const coderFile = join(pieceDir, 'coder.md');
    writeFileSync(coderFile, 'Coder persona');
    const plannerFile = join(pieceDir, 'planner.md');
    writeFileSync(plannerFile, 'Planner persona');

    const raw = {
      name: 'test-piece',
      personas: {
        planner: './planner.md',
        coder: { path: './coder.md', provider: 'codex' },
      },
      movements: [
        { name: 'plan', persona: 'planner', instruction: '{task}' },
        { name: 'implement', persona: 'coder', instruction: '{task}' },
        { name: 'fix', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);

    expect(config.movements[0]!.provider).toBeUndefined();
    expect(config.movements[1]!.provider).toBe('codex');
    expect(config.movements[2]!.provider).toBe('codex');
  });

  it('should apply persona provider to parallel sub-movements', () => {
    const coderFile = join(pieceDir, 'coder.md');
    writeFileSync(coderFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', provider: 'codex' },
      },
      movements: [
        {
          name: 'review',
          instruction: '{task}',
          parallel: [
            { name: 'review-a', persona: 'coder', instruction: '{task}' },
            { name: 'review-b', persona: 'coder', instruction: '{task}' },
          ],
        },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    const parallel = config.movements[0]!.parallel!;
    expect(parallel[0]!.provider).toBe('codex');
    expect(parallel[1]!.provider).toBe('codex');
  });

  it('should normalize personas in PieceConfig output', () => {
    const coderFile = join(pieceDir, 'coder.md');
    writeFileSync(coderFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', provider: 'codex', model: 'gpt-5.2' },
      },
      movements: [
        { name: 'step1', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.personas).toEqual({
      coder: { path: './coder.md', provider: 'codex', model: 'gpt-5.2' },
    });
  });

  it('should normalize string personas in PieceConfig output', () => {
    const coderFile = join(pieceDir, 'coder.md');
    writeFileSync(coderFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: './coder.md',
      },
      movements: [
        { name: 'step1', persona: 'coder', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.personas).toEqual({
      coder: { path: './coder.md' },
    });
  });

  it('should not merge provider for movements without persona reference', () => {
    const coderFile = join(pieceDir, 'coder.md');
    writeFileSync(coderFile, 'Coder persona');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: { path: './coder.md', provider: 'codex' },
      },
      movements: [
        { name: 'step1', instruction: '{task}' },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    expect(config.movements[0]!.provider).toBeUndefined();
  });
});
