import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Eject builtin pieces (takt eject)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try {
      repo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should list available builtin pieces when no name given', () => {
    const result = runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('default');
    expect(result.stdout).toContain('Available builtin pieces');
  });

  it('should eject piece YAML only to project .takt/ by default', () => {
    const result = runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Piece YAML should be in project .takt/pieces/
    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    expect(existsSync(piecePath)).toBe(true);

    // Personas should NOT be copied (resolved via layer system)
    const personasDir = join(repo.path, '.takt', 'personas');
    expect(existsSync(personasDir)).toBe(false);
  });

  it('should preserve content of builtin piece YAML as-is', () => {
    runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    const content = readFileSync(piecePath, 'utf-8');

    // Content should be an exact copy of builtin — paths preserved as-is
    expect(content).toContain('name: default');
    // Should NOT contain rewritten absolute paths
    expect(content).not.toContain('~/.takt/personas/');
  });

  it('should eject piece YAML only to global ~/.takt/ with --global flag', () => {
    const result = runTakt({
      args: ['eject', 'default', '--global'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Piece YAML should be in global dir (TAKT_CONFIG_DIR from isolated env)
    const piecePath = join(isolatedEnv.taktDir, 'pieces', 'default.yaml');
    expect(existsSync(piecePath)).toBe(true);

    // Personas should NOT be copied (resolved via layer system)
    const personasDir = join(isolatedEnv.taktDir, 'personas');
    expect(existsSync(personasDir)).toBe(false);

    // Should NOT be in project dir
    const projectPiecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    expect(existsSync(projectPiecePath)).toBe(false);
  });

  it('should warn and skip when piece already exists', () => {
    // First eject
    runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Second eject — should skip
    const result = runTakt({
      args: ['eject', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already exists');
  });

  it('should report error for non-existent builtin', () => {
    const result = runTakt({
      args: ['eject', 'nonexistent-piece-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not found');
  });

  it('should eject piece YAML only for pieces with unique personas', () => {
    const result = runTakt({
      args: ['eject', 'magi'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Piece YAML should be copied
    const piecePath = join(repo.path, '.takt', 'pieces', 'magi.yaml');
    expect(existsSync(piecePath)).toBe(true);

    // Personas should NOT be copied (resolved via layer system)
    const personasDir = join(repo.path, '.takt', 'personas');
    expect(existsSync(personasDir)).toBe(false);
  });

  it('should eject individual facet to project .takt/', () => {
    const result = runTakt({
      args: ['eject', 'persona', 'coder'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Persona should be copied to project .takt/facets/personas/
    const personaPath = join(repo.path, '.takt', 'facets', 'personas', 'coder.md');
    expect(existsSync(personaPath)).toBe(true);
    const content = readFileSync(personaPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('should eject individual facet to global ~/.takt/ with --global', () => {
    const result = runTakt({
      args: ['eject', 'persona', 'coder', '--global'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    // Persona should be copied to global dir
    const personaPath = join(isolatedEnv.taktDir, 'facets', 'personas', 'coder.md');
    expect(existsSync(personaPath)).toBe(true);

    // Should NOT be in project dir
    const projectPersonaPath = join(repo.path, '.takt', 'facets', 'personas', 'coder.md');
    expect(existsSync(projectPersonaPath)).toBe(false);
  });

  it('should skip eject facet when already exists', () => {
    // First eject
    runTakt({
      args: ['eject', 'persona', 'coder'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Second eject — should skip
    const result = runTakt({
      args: ['eject', 'persona', 'coder'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already exists');
  });

  it('should report error for non-existent facet', () => {
    const result = runTakt({
      args: ['eject', 'persona', 'nonexistent-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not found');
  });

  it('should preserve content of builtin piece YAML for global eject', () => {
    runTakt({
      args: ['eject', 'magi', '--global'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const piecePath = join(isolatedEnv.taktDir, 'pieces', 'magi.yaml');
    const content = readFileSync(piecePath, 'utf-8');

    expect(content).toContain('name: magi');
    expect(content).not.toContain('~/.takt/personas/');
  });
});
