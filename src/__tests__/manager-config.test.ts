import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.project }));
vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: doubles.global }));
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { resolveDirectorConfig } from '../infra/config/directorConfig.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/config-schemas.js';
beforeEach(() => { vi.resetAllMocks(); doubles.project.mockReturnValue({}); doubles.global.mockReturnValue({}); });
it.each([
  { global: ['default', { simple: 'Small changes' }], project: undefined, expected: ['default', { simple: 'Small changes' }] },
  { global: ['default'], project: ['simple'], expected: ['simple'] },
  { global: 'all', project: [], expected: [] },
  { global: ['default'], project: 'all', expected: 'all' },
])('replaces the global manager workflow selection with the project value: %j', ({ global, project, expected }) => {
  doubles.global.mockReturnValue({ manager: { workflows: global } });
  doubles.project.mockReturnValue({ manager: { workflows: project } });
  expect(resolveManagerConfig('/project').workflows).toEqual(expected);
});
it.each(['all', [], ['default', { simple: 'Small changes' }, 'takt-default']])('accepts manager workflows %j at both scopes', (workflows) => {
  for (const schema of [ProjectConfigSchema, GlobalConfigSchema]) {
    expect(schema.parse({ manager: { workflows } }).manager?.workflows).toEqual(workflows);
  }
});
it.each(['default', null, 1, [''], [' '], [{}], [{ '': 'empty' }], [{ ' ': 'blank' }], [{ default: 'one', simple: 'two' }], [{ default: 1 }]])(
  'rejects malformed manager workflows %j at both scopes', (workflows) => {
    for (const schema of [ProjectConfigSchema, GlobalConfigSchema]) {
      expect(schema.safeParse({ manager: { workflows } }).success).toBe(false);
    }
  },
);
it('defaults to automatic execution and requires approval for main merges', () => {
  expect(resolveManagerConfig('/project')).toMatchObject({ permission: 'auto', autoRun: true, mainMerge: 'approve' });
});
it.each([
  { project: {}, global: {}, expected: 'auto' },
  { project: {}, global: { permission: 'full' }, expected: 'full' },
  { project: { permission: 'auto' }, global: { permission: 'full' }, expected: 'auto' },
  { project: { permission: 'full' }, global: { providerPermissions: { codex: 'auto' } }, expected: 'auto' },
  { project: { providerPermissions: { codex: 'full' } }, global: { providerPermissions: { codex: 'auto' } }, expected: 'full' },
  { project: { permission: 'full', providerPermissions: { claude: 'auto' } }, global: {}, expected: 'full' },
])('resolves manager permission from provider overrides before shared defaults: %j', ({ project, global, expected }) => {
  doubles.project.mockReturnValue({ manager: project });
  doubles.global.mockReturnValue({ manager: global });
  expect(resolveManagerConfig('/project', 'codex').permission).toBe(expected);
  expect(doubles.project).toHaveBeenCalledWith('/project');
});
it.each(['claude', 'claude-sdk'] as const)('treats both Claude permission keys as aliases for %s', (provider) => {
  const alias = provider === 'claude' ? 'claude-sdk' : 'claude';
  doubles.global.mockReturnValue({ manager: { permission: 'full', providerPermissions: { [alias]: 'auto' } } });
  expect(resolveManagerConfig('/project', provider).permission).toBe('auto');
  doubles.project.mockReturnValue({ manager: { providerPermissions: { [provider]: 'full' } } });
  expect(resolveManagerConfig('/project', provider).permission).toBe('full');
  doubles.project.mockReturnValue({ manager: { providerPermissions: { [alias]: 'full' } } });
  doubles.global.mockReturnValue({ manager: { providerPermissions: { [provider]: 'auto' } } });
  expect(resolveManagerConfig('/project', provider).permission).toBe('full');
  doubles.project.mockReturnValue({ manager: { providerPermissions: { [provider]: 'auto', [alias]: 'full' } } });
  expect(resolveManagerConfig('/project', provider).permission).toBe('auto');
});
it.each(['auto', 'full'])('accepts manager permission %s at both scopes', (permission) => {
  for (const schema of [ProjectConfigSchema, GlobalConfigSchema]) {
    expect(schema.parse({ manager: { permission, provider_permissions: { claude: permission, codex: permission } } }).manager)
      .toMatchObject({ permission, provider_permissions: { claude: permission, codex: permission } });
  }
});
it.each(['edit', 'readonly', 'AUTO', '', ' ', null, 1, true, {}])('rejects invalid manager permission %j at both scopes', (permission) => {
  for (const schema of [ProjectConfigSchema, GlobalConfigSchema]) {
    expect(schema.safeParse({ manager: { permission } }).success).toBe(false);
    expect(schema.safeParse({ manager: { provider_permissions: { codex: permission } } }).success).toBe(false);
  }
});
it.each([null, 'auto', ['auto']])('rejects invalid provider permissions map %j', (provider_permissions) => {
  for (const schema of [ProjectConfigSchema, GlobalConfigSchema]) {
    expect(schema.safeParse({ manager: { provider_permissions } }).success).toBe(false);
  }
});
it.each([1, 60, 900, 1800])('accepts manager patrol interval %s in seconds', (patrol_interval) => {
  expect(ProjectConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(true);
  expect(GlobalConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(true);
});
it.each([0, -1, 0.5, '1800', null, Number.POSITIVE_INFINITY])('rejects invalid manager patrol interval %s', (patrol_interval) => {
  expect(ProjectConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(false);
  expect(GlobalConfigSchema.safeParse({ manager: { patrol_interval } }).success).toBe(false);
});
it.each([0, 600, 900, -1, 0.5, '600'])('ignores removed director patrol setting %s', (patrol_interval) => {
  expect(GlobalConfigSchema.safeParse({ director: { patrol_interval } }).success).toBe(true);
});
it('resolves project auto run before the global setting', () => {
  doubles.project.mockReturnValue({ manager: { autoRun: false } });
  doubles.global.mockReturnValue({ manager: { autoRun: true } });
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: false, mainMerge: 'approve' });
  doubles.project.mockReturnValue({});
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: true, mainMerge: 'approve' });
});
it.each(['auto', 'approve'])('uses repository main merge permission %s', (mainMerge) => {
  doubles.project.mockReturnValue({ manager: { mainMerge } });
  expect(resolveManagerConfig('/project')).toMatchObject({ mainMerge });
});
it('does not inherit global permission to merge into main', () => {
  doubles.global.mockReturnValue({ manager: { mainMerge: 'auto', autoRun: false } });
  expect(resolveManagerConfig('/project')).toMatchObject({ mainMerge: 'approve', autoRun: false });
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

it('serializes manager patrol configuration while leaving director patrol disabled', async () => {
  const { serializeGlobalConfig } = await import('../infra/config/global/globalConfigSerializer.js');
  const slack = { channelId: 'C0DIR', allowedUserIds: ['U0AAA'] };
  const serialized = serializeGlobalConfig({ language: 'en', autoFetch: true, director: { slack }, manager: { autoRun: false, patrolInterval: 1800 } });
  const parsed = GlobalConfigSchema.parse(serialized);
  expect(parsed.director).toEqual({ slack: { channel_id: 'C0DIR', allowed_user_ids: ['U0AAA'] } });
  expect(parsed.manager).toMatchObject({ auto_run: false });
  expect(parsed.manager).toHaveProperty('patrol_interval', 1800);
  expect(parsed.director).not.toHaveProperty('patrol_interval');
});
