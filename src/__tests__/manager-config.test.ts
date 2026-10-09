import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.project }));
vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: doubles.global }));
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
beforeEach(() => { vi.resetAllMocks(); doubles.project.mockReturnValue({}); doubles.global.mockReturnValue({}); });
it('defaults to automatic execution without inventing a default workflow', () => {
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: true, defaultWorkflow: undefined, mainMerge: 'approve' });
});
it('resolves project and global settings separately for each field', () => {
  doubles.project.mockReturnValue({ manager: { autoRun: false } });
  doubles.global.mockReturnValue({ manager: { autoRun: true, defaultWorkflow: 'global-workflow' } });
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: false, defaultWorkflow: 'global-workflow', mainMerge: 'approve' });
  doubles.project.mockReturnValue({ manager: { defaultWorkflow: 'project-workflow' } });
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: true, defaultWorkflow: 'project-workflow', mainMerge: 'approve' });
});
it.each(['auto', 'approve'])('uses repository main merge permission %s', (mainMerge) => {
  doubles.project.mockReturnValue({ manager: { mainMerge } });
  expect(resolveManagerConfig('/project')).toMatchObject({ mainMerge });
});
it('does not inherit global permission to merge into main', () => {
  doubles.global.mockReturnValue({ manager: { mainMerge: 'auto', autoRun: false, defaultWorkflow: 'global-workflow' } });
  expect(resolveManagerConfig('/project')).toMatchObject({ mainMerge: 'approve', autoRun: false, defaultWorkflow: 'global-workflow' });
});

const notificationKinds = ['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom'] as const;

it('enables every manager notification kind when configuration is omitted', () => {
  expect(resolveManagerConfig('/project')).toMatchObject({
    notifications: Object.fromEntries(notificationKinds.map((kind) => [kind, true])),
  });
});

it.each(notificationKinds)('resolves %s independently without disabling other notification kinds', (kind) => {
  doubles.global.mockReturnValue({ manager: { notifications: { [kind]: false } } });
  expect(resolveManagerConfig('/project')).toMatchObject({
    notifications: Object.fromEntries(notificationKinds.map((candidate) => [candidate, candidate !== kind])),
  });

  doubles.project.mockReturnValue({ manager: { notifications: { [kind]: true } } });
  expect(resolveManagerConfig('/project')).toMatchObject({
    notifications: Object.fromEntries(notificationKinds.map((candidate) => [candidate, true])),
  });
});

it.each(notificationKinds)('prioritizes explicit project false over global true for %s only', (kind) => {
  const enabled = Object.fromEntries(notificationKinds.map((candidate) => [candidate, true]));
  doubles.global.mockReturnValue({ manager: { notifications: enabled } });
  doubles.project.mockReturnValue({ manager: { notifications: { [kind]: false } } });

  expect(resolveManagerConfig('/project').notifications).toEqual({ ...enabled, [kind]: false });

  doubles.project.mockReturnValue({ manager: { notifications: { [kind]: true } } });
  expect(resolveManagerConfig('/project').notifications).toEqual(enabled);
});
