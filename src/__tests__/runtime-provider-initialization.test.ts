import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
// New module under test (implemented in the following `implement` step).
import { generateGlobalRuntimeProviderFile } from '../infra/config/runtime-provider/initialization.js';
import { RuntimeProviderFileSchema, type RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';
import { hasActiveProviderSection } from '../infra/config/runtime-provider/mode.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C17 new environment: an *active* global runtime.yaml is generated from the selected
 *       provider/model (profiles.default + defaults.profile), not overwriting an existing
 *       file, written atomically, only validated content is written
 * - C18 existing legacy environment: an *inactive* `version: 1` file is generated so behavior
 *       does not switch
 *
 * `generateGlobalRuntimeProviderFile({ runtimeFilePath, selection, hasLegacyProviderConfig })`.
 */

let dir: string;
let runtimeFilePath: string;

function read(): unknown {
  return parseYaml(readFileSync(runtimeFilePath, 'utf-8'));
}

/** Schema-validated read: fails the test on shape drift instead of hiding it behind `any`. */
function readValidated(): RuntimeProviderFile {
  return RuntimeProviderFileSchema.parse(read());
}

describe('generateGlobalRuntimeProviderFile', () => {
  beforeEach(() => {
    // Unique per-run directory: a fixed tmpdir path would let two concurrent runs of this
    // file delete each other's fixtures.
    dir = mkdtempSync(join(tmpdir(), 'takt-runtime-provider-init-'));
    runtimeFilePath = join(dir, 'runtime.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('Given a new environment with a selection, When generating, Then an active file is written from provider/model (C17)', () => {
    generateGlobalRuntimeProviderFile({
      runtimeFilePath,
      selection: { provider: 'codex', model: 'gpt-5.6-sol' },
      hasLegacyProviderConfig: false,
    });

    const doc = readValidated();
    expect(doc.version).toBe(1);
    expect(doc.provider?.profiles?.default).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(doc.provider?.defaults?.profile).toBe('default');
    expect(hasActiveProviderSection(doc)).toBe(true);
  });

  it('Given an existing legacy environment, When generating, Then only an inactive `version: 1` file is written (C18)', () => {
    generateGlobalRuntimeProviderFile({
      runtimeFilePath,
      selection: { provider: 'codex', model: 'gpt-5.6-sol' },
      hasLegacyProviderConfig: true,
    });

    const doc = readValidated();
    expect(doc.version).toBe(1);
    expect(doc.provider).toBeUndefined();
    expect(hasActiveProviderSection(doc)).toBe(false);
  });

  it('Given an already-present runtime.yaml, When generating, Then it is not overwritten (C17)', () => {
    const original = 'version: 1\nprovider:\n  defaults:\n    profile: custom\n  profiles:\n    custom:\n      provider: mock\n      model: kept\n';
    writeFileSync(runtimeFilePath, original, 'utf-8');

    generateGlobalRuntimeProviderFile({
      runtimeFilePath,
      selection: { provider: 'codex', model: 'gpt-5.6-sol' },
      hasLegacyProviderConfig: false,
    });

    expect(readFileSync(runtimeFilePath, 'utf-8')).toBe(original);
  });

  it('Given a generated active file, When validating, Then the written content passes schema validation (C17)', () => {
    generateGlobalRuntimeProviderFile({
      runtimeFilePath,
      selection: { provider: 'codex', model: 'gpt-5.6-sol' },
      hasLegacyProviderConfig: false,
    });
    expect(RuntimeProviderFileSchema.safeParse(read()).success).toBe(true);
  });

  it('Given a generated inactive file, When validating, Then the written content passes schema validation (C18)', () => {
    generateGlobalRuntimeProviderFile({ runtimeFilePath, selection: undefined, hasLegacyProviderConfig: true });
    expect(RuntimeProviderFileSchema.safeParse(read()).success).toBe(true);
  });

  it('Given a new environment without a selection, When generating, Then it fails fast and writes nothing (C17)', () => {
    expect(() =>
      generateGlobalRuntimeProviderFile({
        runtimeFilePath,
        selection: undefined,
        hasLegacyProviderConfig: false,
      }),
    ).toThrow(/selection/i);
    expect(existsSync(runtimeFilePath)).toBe(false);
  });

  it('Given generation completes, When inspecting the directory, Then no temp file is left behind (atomic write, C17)', () => {
    generateGlobalRuntimeProviderFile({
      runtimeFilePath,
      selection: { provider: 'codex', model: 'gpt-5.6-sol' },
      hasLegacyProviderConfig: false,
    });
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
    expect(existsSync(runtimeFilePath)).toBe(true);
  });
});
