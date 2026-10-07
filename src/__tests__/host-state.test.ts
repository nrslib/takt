import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ config: vi.fn(), realpath: vi.fn(), stat: vi.fn(), safe: vi.fn() }));
vi.mock('node:fs', () => ({ realpathSync: doubles.realpath }));
vi.mock('../infra/config/paths.js', () => ({ getGlobalConfigDir: doubles.config }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: doubles.safe, lstatOrUndefined: doubles.stat }));
import { hostProjectStateDirectory } from '../infra/config/host-state.js';
beforeEach(() => {
  vi.resetAllMocks();
  doubles.config.mockReturnValue('/host/config');
  doubles.realpath.mockImplementation((path: string) => path === '/alias-project' ? '/project' : path);
  doubles.stat.mockReturnValue({});
});
it('uses canonical project namespaces and separates other projects', () => {
  expect(hostProjectStateDirectory('/alias-project', 'manager-runs')).toBe(hostProjectStateDirectory('/project', 'manager-runs'));
  expect(hostProjectStateDirectory('/other', 'manager-runs')).not.toBe(hostProjectStateDirectory('/project', 'manager-runs'));
  expect(hostProjectStateDirectory('/project', 'goal-completions')).not.toBe(hostProjectStateDirectory('/project', 'manager-runs'));
});
it.each(['/project', '/project/config'])('refuses host storage within the project: %s', (path) => {
  doubles.config.mockReturnValue(path);
  expect(() => hostProjectStateDirectory('/project', 'manager-runs')).toThrow('outside the project');
});
it('checks the real existing ancestor of a destination that does not exist yet', () => {
  doubles.config.mockReturnValue('/host/alias/missing/config');
  doubles.stat.mockImplementation((path: string) => path === '/host/alias' ? {} : undefined);
  doubles.realpath.mockImplementation((path: string) => path === '/host/alias' ? '/project' : path);
  expect(() => hostProjectStateDirectory('/project', 'goal-completions')).toThrow('outside the project');
  expect(doubles.safe).toHaveBeenCalledWith('/host/alias/missing/config', true);
});
