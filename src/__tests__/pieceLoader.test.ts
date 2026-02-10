/**
 * Tests for isPiecePath and loadPieceByIdentifier
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPiecePath,
  loadPieceByIdentifier,
  listPieces,
  loadAllPieces,
} from '../infra/config/loaders/pieceLoader.js';

const SAMPLE_PIECE = `name: test-piece
description: Test piece
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

describe('isPiecePath', () => {
  it('should return true for absolute paths', () => {
    expect(isPiecePath('/path/to/piece.yaml')).toBe(true);
    expect(isPiecePath('/piece')).toBe(true);
  });

  it('should return true for home directory paths', () => {
    expect(isPiecePath('~/piece.yaml')).toBe(true);
    expect(isPiecePath('~/.takt/pieces/custom.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ./', () => {
    expect(isPiecePath('./piece.yaml')).toBe(true);
    expect(isPiecePath('./subdir/piece.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ../', () => {
    expect(isPiecePath('../piece.yaml')).toBe(true);
    expect(isPiecePath('../subdir/piece.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yaml', () => {
    expect(isPiecePath('custom.yaml')).toBe(true);
    expect(isPiecePath('my-piece.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yml', () => {
    expect(isPiecePath('custom.yml')).toBe(true);
    expect(isPiecePath('my-piece.yml')).toBe(true);
  });

  it('should return false for plain piece names', () => {
    expect(isPiecePath('default')).toBe(false);
    expect(isPiecePath('simple')).toBe(false);
    expect(isPiecePath('magi')).toBe(false);
    expect(isPiecePath('my-custom-piece')).toBe(false);
  });
});

describe('loadPieceByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load piece by name (builtin)', () => {
    const piece = loadPieceByIdentifier('default', process.cwd());
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('default');
  });

  it('should load piece by absolute path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier(filePath, tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should load piece by relative path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier('./test.yaml', tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should load piece by filename with .yaml extension', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_PIECE);

    const piece = loadPieceByIdentifier('test.yaml', tempDir);
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('test-piece');
  });

  it('should return null for non-existent name', () => {
    const piece = loadPieceByIdentifier('non-existent-piece-xyz', process.cwd());
    expect(piece).toBeNull();
  });

  it('should return null for non-existent path', () => {
    const piece = loadPieceByIdentifier('./non-existent.yaml', tempDir);
    expect(piece).toBeNull();
  });
});

describe('listPieces with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local pieces when cwd is provided', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'project-custom.yaml'), SAMPLE_PIECE);

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('project-custom');
  });

  it('should include builtin pieces regardless of cwd', () => {
    const pieces = listPieces(tempDir);
    expect(pieces).toContain('default');
  });

});

describe('loadAllPieces with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local pieces when cwd is provided', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'project-custom.yaml'), SAMPLE_PIECE);

    const pieces = loadAllPieces(tempDir);
    expect(pieces.has('project-custom')).toBe(true);
    expect(pieces.get('project-custom')!.name).toBe('test-piece');
  });

  it('should have project-local override builtin when same name', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });

    const overridePiece = `name: project-override
description: Project override
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;
    writeFileSync(join(projectPiecesDir, 'default.yaml'), overridePiece);

    const pieces = loadAllPieces(tempDir);
    expect(pieces.get('default')!.name).toBe('project-override');
  });

});
