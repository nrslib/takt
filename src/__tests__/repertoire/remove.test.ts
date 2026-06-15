/**
 * Regression test for repertoireRemoveCommand scan configuration.
 *
 * Verifies that findScopeReferences is called with exactly the 3 spec-defined
 * scan locations:
 *   1. ~/.takt/workflows (global workflows dir)
 *   2. .takt/workflows (project workflows dir)
 *   3. ~/.takt/provider-options (global provider_options dir)
 *   4. .takt/provider-options (project provider_options dir)
 *   5. ~/.takt/preferences/workflow-categories.yaml (categories file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  realpathSync: vi.fn((path: string) => path),
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
  getGlobalWorkflowsDir: vi.fn().mockReturnValue('/home/user/.takt/workflows'),
  getProjectWorkflowsDir: vi.fn().mockReturnValue('/project/.takt/workflows'),
  getGlobalProviderOptionsDir: vi.fn().mockReturnValue('/home/user/.takt/provider-options'),
  getProjectProviderOptionsDir: vi.fn().mockReturnValue('/project/.takt/provider-options'),
}));

vi.mock('../../infra/config/global/index.js', () => ({
  getWorkflowCategoriesPath: vi.fn().mockReturnValue('/home/user/.takt/preferences/workflow-categories.yaml'),
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
import { getWorkflowCategoriesPath } from '../../infra/config/global/index.js';
import { confirm } from '../../shared/prompt/index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repertoireRemoveCommand — scan configuration', () => {
  beforeEach(() => {
    vi.mocked(findScopeReferences).mockClear();
    vi.mocked(findScopeReferences).mockReturnValue([]);
    vi.mocked(getWorkflowCategoriesPath).mockClear();
    vi.mocked(getWorkflowCategoriesPath).mockReturnValue('/home/user/.takt/preferences/workflow-categories.yaml');
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(realpathSync).mockImplementation((path: string) => path);
  });

  it('should call findScopeReferences with workflow, provider-options, and categories scan targets', async () => {
    // When: remove command is invoked (confirm returns false → no deletion)
    await repertoireRemoveCommand('@owner/repo');

    // Then: findScopeReferences is called once
    expect(findScopeReferences).toHaveBeenCalledOnce();

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: exactly 2 workflow directories
    expect(scanConfig.workflowDirs).toHaveLength(2);

    // Then: exactly 2 provider-options directories
    expect(scanConfig.providerOptionsDirs).toHaveLength(2);

    // Then: exactly 1 categories file
    expect(scanConfig.categoriesFiles).toHaveLength(1);
  });

  it('should include global workflows dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: global workflows dir is in the scan list
    expect(scanConfig.workflowDirs).toContain('/home/user/.takt/workflows');
  });

  it('should include project workflows dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: project workflows dir is in the scan list
    expect(scanConfig.workflowDirs).toContain('/project/.takt/workflows');
  });

  it('should include global provider-options dir in scan', async () => {
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(scanConfig.providerOptionsDirs).toContain('/home/user/.takt/provider-options');
  });

  it('should include project provider-options dir in scan', async () => {
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(scanConfig.providerOptionsDirs).toContain('/project/.takt/provider-options');
  });

  it('should include preferences/workflow-categories.yaml in categoriesFiles', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: the categories file path is correct
    expect(scanConfig.categoriesFiles).toContain(
      join('/home/user/.takt', 'preferences', 'workflow-categories.yaml'),
    );
  });

  it('should use the resolved workflow categories path override', async () => {
    vi.mocked(getWorkflowCategoriesPath).mockReturnValue('/custom/workflow-categories.yaml');

    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(getWorkflowCategoriesPath).toHaveBeenCalledWith(process.cwd());
    expect(scanConfig.categoriesFiles).toEqual(['/custom/workflow-categories.yaml']);
  });

  it('should pass the scope as the first argument to findScopeReferences', async () => {
    // When: remove command is invoked with a scope
    await repertoireRemoveCommand('@owner/repo');

    const [scope] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: scope is passed correctly
    expect(scope).toBe('@owner/repo');
  });

  it('should reject a scope whose repo segment escapes the package directory', async () => {
    await expect(repertoireRemoveCommand('@owner/../../tmp/target')).rejects.toThrow();

    expect(findScopeReferences).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('should reject deletion when the resolved package directory is outside the repertoire directory', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(realpathSync).mockImplementation((path: string) => (
      path === '/home/user/.takt/repertoire/@owner/repo' ? '/tmp/target' : path
    ));

    await expect(repertoireRemoveCommand('@owner/repo')).rejects.toThrow(/escapes repertoire directory/);

    expect(rmSync).not.toHaveBeenCalled();
  });
});
