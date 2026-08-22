import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfirm,
  mockFs,
  mockRmSync,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    realpathSync: vi.fn(),
    statSync: vi.fn(),
  },
  mockRmSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  ...mockFs,
  rmSync: mockRmSync,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getGlobalProviderOptionsDir: () => '/global/provider-options',
  getGlobalStepsDir: () => '/global/steps',
  getGlobalWorkflowsDir: () => '/global/workflows',
  getGlobalFacetPoolsDir: () => '/global/facet-pools',
  getProjectProviderOptionsDir: () => '/project/.takt/provider-options',
  getProjectStepsDir: () => '/project/.takt/steps',
  getProjectWorkflowsDir: () => '/project/.takt/workflows',
  getProjectFacetPoolsDir: () => '/project/.takt/facet-pools',
  getRepertoireDir: () => '/home/user/.takt/repertoire',
  getRepertoirePackageDir: () => '/home/user/.takt/repertoire/@owner/repo',
}));

vi.mock('../../infra/config/global/index.js', () => ({
  getWorkflowCategoriesPath: () => '/global/preferences/workflow-categories.yaml',
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
}));

import { repertoireRemoveCommand } from '../../commands/repertoire/remove.js';

const PACKAGE_DIR = '/home/user/.takt/repertoire/@owner/repo';
const OWNER_DIR = '/home/user/.takt/repertoire/@owner';
const WORKFLOW_DIR = '/global/workflows';
const STEP_DIR = '/global/steps';

describe('repertoireRemoveCommand reference scan integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockFs.existsSync.mockImplementation((path: string) => path === PACKAGE_DIR);
    mockFs.lstatSync.mockImplementation(throwNotFound);
    mockFs.readFileSync.mockImplementation(throwNotFound);
    mockFs.readdirSync.mockImplementation(throwNotFound);
    mockFs.realpathSync.mockImplementation((path: string) => path);
    mockFs.statSync.mockImplementation(throwNotFound);
  });

  it('should not confirm or delete when the real reference scanner cannot enumerate a configured workflow directory', async () => {
    mockFs.statSync.mockImplementation((path: string) => (
      path === WORKFLOW_DIR ? directoryStats() : throwNotFound()
    ));
    mockFs.readdirSync.mockImplementation((path: string) => {
      if (path === WORKFLOW_DIR) {
        throw new Error('permission denied');
      }
      return throwNotFound();
    });

    const error = await captureError(() => repertoireRemoveCommand('@owner/repo'));

    expect(error.message).toBe(`Failed to read directory while scanning references: ${WORKFLOW_DIR}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('should not confirm or delete when the owner directory cannot be scanned before removal', async () => {
    mockFs.existsSync.mockImplementation((path: string) => path === PACKAGE_DIR || path === OWNER_DIR);
    mockFs.readdirSync.mockImplementation((path: string) => {
      if (path === OWNER_DIR) {
        throw new Error('permission denied');
      }
      return throwNotFound();
    });

    const error = await captureError(() => repertoireRemoveCommand('@owner/repo'));

    expect(error.message).toBe(`Failed to read directory while scanning references: ${OWNER_DIR}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('should not confirm or delete when the real reference scanner cannot inspect an enumerated workflow file', async () => {
    const workflowPath = `${WORKFLOW_DIR}/review.yaml`;
    mockFs.statSync.mockImplementation((path: string) => {
      if (path === WORKFLOW_DIR) return directoryStats();
      if (path === workflowPath) throw new Error('permission denied');
      return throwNotFound();
    });
    mockFs.readdirSync.mockImplementation((path: string) => (
      path === WORKFLOW_DIR ? ['review.yaml'] : throwNotFound()
    ));

    const error = await captureError(() => repertoireRemoveCommand('@owner/repo'));

    expect(error.message).toBe(`Failed to inspect YAML file while scanning references: ${workflowPath}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('should not confirm or delete when the real reference scanner cannot read an enumerated workflow file', async () => {
    const workflowPath = `${WORKFLOW_DIR}/review.yaml`;
    mockFs.statSync.mockImplementation((path: string) => {
      if (path === WORKFLOW_DIR) return directoryStats();
      if (path === workflowPath) return fileStats();
      return throwNotFound();
    });
    mockFs.readdirSync.mockImplementation((path: string) => (
      path === WORKFLOW_DIR ? ['review.yaml'] : throwNotFound()
    ));
    mockFs.readFileSync.mockImplementation((path: string) => {
      if (path === workflowPath) throw new Error('permission denied');
      return throwNotFound();
    });

    const error = await captureError(() => repertoireRemoveCommand('@owner/repo'));

    expect(error.message).toBe(`Failed to read YAML file while scanning references: ${workflowPath}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('should not confirm or delete when the real reference scanner cannot resolve a step fragment symlink', async () => {
    const stepPath = `${STEP_DIR}/review.yaml`;
    mockFs.statSync.mockImplementation((path: string) => (
      path === STEP_DIR ? directoryStats() : throwNotFound()
    ));
    mockFs.lstatSync.mockImplementation((path: string) => {
      if (path === stepPath) return symlinkStats();
      return throwNotFound();
    });
    mockFs.readdirSync.mockImplementation((path: string) => (
      path === STEP_DIR ? ['review.yaml'] : throwNotFound()
    ));
    mockFs.realpathSync.mockImplementation((path: string) => {
      if (path === stepPath) throw new Error('broken symlink');
      return path;
    });

    const error = await captureError(() => repertoireRemoveCommand('@owner/repo'));

    expect(error.message).toBe(`Failed to resolve step fragment while scanning references: ${stepPath}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

function directoryStats() {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function fileStats() {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function symlinkStats() {
  return {
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  };
}

function throwNotFound(): never {
  throw Object.assign(new Error('not found'), { code: 'ENOENT' });
}

async function captureError(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected action to reject');
}
