import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.project }));
vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: doubles.global }));
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
beforeEach(() => { vi.resetAllMocks(); doubles.project.mockReturnValue({}); doubles.global.mockReturnValue({}); });
it('defaults to automatic execution without inventing a default workflow', () => {
  expect(resolveManagerConfig('/project')).toEqual({ autoRun: true, defaultWorkflow: undefined });
});
it('resolves project and global settings separately for each field', () => {
  doubles.project.mockReturnValue({ manager: { autoRun: false } });
  doubles.global.mockReturnValue({ manager: { autoRun: true, defaultWorkflow: 'global-workflow' } });
  expect(resolveManagerConfig('/project')).toEqual({ autoRun: false, defaultWorkflow: 'global-workflow' });
  doubles.project.mockReturnValue({ manager: { defaultWorkflow: 'project-workflow' } });
  expect(resolveManagerConfig('/project')).toEqual({ autoRun: true, defaultWorkflow: 'project-workflow' });
});
