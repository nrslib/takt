/**
 * Regression test for repertoireRemoveCommand scan configuration.
 *
 * Verifies that findScopeReferences is called with exactly the 3 spec-defined
 * scan locations:
 *   1. ~/.takt/pieces (global pieces dir)
 *   2. .takt/pieces (project pieces dir)
 *   3. ~/.takt/preferences/piece-categories.yaml (categories file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  rmSync: vi.fn(),
}));

vi.mock('../../features/repertoire/remove.js', () => ({
  findScopeReferences: vi.fn().mockReturnValue([]),
  shouldRemoveOwnerDir: vi.fn().mockReturnValue(false),
}));

vi.mock('../../infra/config/paths.js', () => ({
  getRepertoireDir: vi.fn().mockReturnValue('/home/user/.takt/repertoire'),
  getRepertoirePackageDir: vi.fn().mockReturnValue('/home/user/.takt/repertoire/@owner/repo'),
  getGlobalConfigDir: vi.fn().mockReturnValue('/home/user/.takt'),
  getGlobalPiecesDir: vi.fn().mockReturnValue('/home/user/.takt/pieces'),
  getProjectPiecesDir: vi.fn().mockReturnValue('/project/.takt/pieces'),
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks are declared
// ---------------------------------------------------------------------------

import { repertoireRemoveCommand } from '../../commands/repertoire/remove.js';
import { findScopeReferences } from '../../features/repertoire/remove.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repertoireRemoveCommand — scan configuration', () => {
  beforeEach(() => {
    vi.mocked(findScopeReferences).mockReturnValue([]);
  });

  it('should call findScopeReferences with exactly 2 piecesDirs and 1 categoriesFile', async () => {
    // When: remove command is invoked (confirm returns false → no deletion)
    await repertoireRemoveCommand('@owner/repo');

    // Then: findScopeReferences is called once
    expect(findScopeReferences).toHaveBeenCalledOnce();

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: exactly 2 piece directories
    expect(scanConfig.piecesDirs).toHaveLength(2);

    // Then: exactly 1 categories file
    expect(scanConfig.categoriesFiles).toHaveLength(1);
  });

  it('should include global pieces dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: global pieces dir is in the scan list
    expect(scanConfig.piecesDirs).toContain('/home/user/.takt/pieces');
  });

  it('should include project pieces dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: project pieces dir is in the scan list
    expect(scanConfig.piecesDirs).toContain('/project/.takt/pieces');
  });

  it('should include preferences/piece-categories.yaml in categoriesFiles', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: the categories file path is correct
    expect(scanConfig.categoriesFiles).toContain(
      join('/home/user/.takt', 'preferences', 'piece-categories.yaml'),
    );
  });

  it('should pass the scope as the first argument to findScopeReferences', async () => {
    // When: remove command is invoked with a scope
    await repertoireRemoveCommand('@owner/repo');

    const [scope] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: scope is passed correctly
    expect(scope).toBe('@owner/repo');
  });
});
