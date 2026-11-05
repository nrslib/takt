import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.project }));
vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: doubles.global }));
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { resolveDirectorConfig } from '../infra/config/directorConfig.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/config-schemas.js';
beforeEach(() => { vi.resetAllMocks(); doubles.project.mockReturnValue({}); doubles.global.mockReturnValue({}); });
it('defaults to automatic execution without inventing a default workflow', () => {
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: true, defaultWorkflow: undefined, mainMerge: 'approve' });
});
it.each([0, 60, 900, -1, 0.5, '1800'])('ignores removed manager patrol setting %s', (patrol_interval) => {
  expect(ProjectConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(true);
  expect(GlobalConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(true);
});
it.each([0, 600, 900, -1, 0.5, '600'])('ignores removed director patrol setting %s', (patrol_interval) => {
  expect(GlobalConfigSchema.safeParse({ director: { patrol_interval } }).success).toBe(true);
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

it.each([[], ['private'], null, 'private', [42]])('ignores deprecated sensitive_paths: %j', (sensitive_paths) => {
  expect(ProjectConfigSchema.safeParse({ manager: { sensitive_paths } }).success).toBe(true);
  expect(GlobalConfigSchema.safeParse({ manager: { sensitive_paths } }).success).toBe(true);
  doubles.global.mockReturnValue({ manager: { sensitivePaths: ['global'] } });
  doubles.project.mockReturnValue({ manager: { sensitivePaths: ['project'] } });
  expect(resolveManagerConfig('/project')).not.toHaveProperty('sensitivePaths');
});

it.each([{ allowedUserIds: ['U0AAA', 'U0BBB'] }, { allowedUserIds: [] }])('accepts repository Slack channel and allowed user IDs $allowedUserIds', ({ allowedUserIds }) => {
  const slack = { channel_id: 'C0123', allowed_user_ids: allowedUserIds };

  expect(ProjectConfigSchema.parse({ manager: { slack } })).toMatchObject({ manager: { slack } });
});

it.each([
  { channel_id: 123, allowed_user_ids: ['U0AAA'] },
  { channel_id: 'C0123', allowed_user_ids: 'U0AAA' },
  { channel_id: 'C0123', allowed_user_ids: [123] },
  { channel_id: 'C0123' },
  { allowed_user_ids: ['U0AAA'] },
])('rejects Slack settings without a string channel and a string user list: %j', (slack) => {
  expect(ProjectConfigSchema.safeParse({ manager: { slack } }).success).toBe(false);
});

it.each(['app_token', 'bot_token'])('rejects %s in repository Slack settings', (key) => {
  const slack = { channel_id: 'C0123', allowed_user_ids: ['U0AAA'], [key]: 'environment-only' };

  expect(ProjectConfigSchema.safeParse({ manager: { slack } }).success).toBe(false);
});

it('keeps Slack channel authorization specific to repository configuration', () => {
  const slack = { channel_id: 'C0123', allowed_user_ids: ['U0AAA'] };

  expect(GlobalConfigSchema.safeParse({ manager: { slack } }).success).toBe(false);
});

it.each([{ allowedUserIds: ['U0AAA', 'U0BBB'] }, { allowedUserIds: [] }])('accepts director Slack settings in global configuration with users $allowedUserIds', ({ allowedUserIds }) => {
  const slack = { channel_id: 'C0DIR', allowed_user_ids: allowedUserIds };
  const input = { director: { slack } };
  expect(GlobalConfigSchema.parse(input)).toMatchObject(input);
  expect(ProjectConfigSchema.safeParse(input).success).toBe(false);
});

it.each([
  null,
  { channel_id: 123, allowed_user_ids: ['U0AAA'] },
  { channel_id: 'C0DIR', allowed_user_ids: 'U0AAA' },
  { channel_id: 'C0DIR', allowed_user_ids: [123] },
  { channel_id: 'C0DIR' },
  { allowed_user_ids: ['U0AAA'] },
  { channel_id: ' ', allowed_user_ids: ['U0AAA'] },
  { channel_id: 'C0DIR', allowed_user_ids: [' '] },
])('rejects invalid director Slack settings %j', (slack) => {
  expect(GlobalConfigSchema.safeParse({ director: { slack } }).success).toBe(false);
});

it.each(['app_token', 'bot_token', 'unknown'])('rejects the unknown director Slack key %s', (key) => {
  const slack = { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'], [key]: 'environment-only' };
  expect(GlobalConfigSchema.safeParse({ director: { slack } }).success).toBe(false);
});

it('resolves director Slack from the already loaded global configuration', () => {
  const slack = { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] };
  const config = { language: 'en' as const, autoFetch: true, director: { slack } };
  expect(resolveDirectorConfig(config)).toMatchObject({ slack });
  expect(resolveDirectorConfig({ language: 'en', autoFetch: true })).not.toHaveProperty('slack.channelId');
  expect(doubles.global).not.toHaveBeenCalled();
  expect(doubles.project).not.toHaveBeenCalled();
});

it('serializes supported director and manager settings without restoring patrol configuration', async () => {
  const { serializeGlobalConfig } = await import('../infra/config/global/globalConfigSerializer.js');
  const slack = { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] };
  const serialized = serializeGlobalConfig({ language: 'en', autoFetch: true, director: { slack }, manager: { autoRun: false } });
  const parsed = GlobalConfigSchema.parse(serialized);
  expect(parsed.director).toEqual({ slack: { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'] } });
  expect(parsed.manager).toMatchObject({ auto_run: false });
  expect(parsed.manager).not.toHaveProperty('patrol_interval');
  expect(parsed.director).not.toHaveProperty('patrol_interval');
});
