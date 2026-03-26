import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/resolvePieceConfigValue.js', () => ({
  resolvePieceConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolvePieceConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

const { listPieces, loadPiece, loadAllPiecesWithSources } = await import('../infra/config/loaders/pieceLoader.js');

const PROJECT_PIECE = `name: project-only
description: project piece
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "project"
`;

describe('project config dir collision in pieceResolver', () => {
  let projectDir: string;
  let realGlobalDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-piece-resolver-collision-'));
    realGlobalDir = mkdtempSync(join(tmpdir(), 'takt-piece-resolver-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    symlinkSync(realGlobalDir, join(projectDir, '.takt'));
    process.env.TAKT_CONFIG_DIR = realGlobalDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('should not list colliding global pieces as project-local pieces', () => {
    const globalPiecesDir = join(realGlobalDir, 'pieces');
    mkdirSync(globalPiecesDir, { recursive: true });
    writeFileSync(join(globalPiecesDir, 'project-only.yaml'), PROJECT_PIECE, 'utf-8');

    const pieces = listPieces(projectDir);

    expect(pieces).toContain('project-only');
    expect(pieces.filter((name) => name === 'project-only')).toHaveLength(1);
  });

  it('should load colliding pieces through the user layer only', () => {
    const globalPiecesDir = join(realGlobalDir, 'pieces');
    mkdirSync(globalPiecesDir, { recursive: true });
    writeFileSync(join(globalPiecesDir, 'project-only.yaml'), PROJECT_PIECE, 'utf-8');

    const loaded = loadPiece('project-only', projectDir);
    const withSources = loadAllPiecesWithSources(projectDir);

    expect(loaded?.name).toBe('project-only');
    expect(withSources.get('project-only')?.source).toBe('user');
  });
});
