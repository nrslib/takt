import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ project: vi.fn(), global: vi.fn() }));
vi.mock('../infra/config/project/projectConfig.js', () => ({ loadProjectConfig: doubles.project }));
vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: doubles.global }));
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/config-schemas.js';
beforeEach(() => { vi.resetAllMocks(); doubles.project.mockReturnValue({}); doubles.global.mockReturnValue({}); });
it('defaults to automatic execution without inventing a default workflow', () => {
  expect(resolveManagerConfig('/project')).toMatchObject({ autoRun: true, defaultWorkflow: undefined, mainMerge: 'approve' });
});
it('defaults patrols to 15 minutes when neither configuration specifies an interval', () => {
  expect(resolveManagerConfig('/project').patrolInterval).toBe(900);
});
it('prioritizes project patrol intervals and falls back to the explicit global interval', () => {
  doubles.global.mockReturnValue({ manager: { patrolInterval: 1800 } });
  doubles.project.mockReturnValue({ manager: { patrolInterval: 600 } });
  expect(resolveManagerConfig('/project').patrolInterval).toBe(600);
  doubles.project.mockReturnValue({});
  expect(resolveManagerConfig('/project').patrolInterval).toBe(1800);
});
it.each([0, -1, 0.5, '1800', Infinity])('rejects invalid patrol interval %s at the configuration boundary', (patrol_interval) => {
  const input = { manager: { patrol_interval } };
  expect(ProjectConfigSchema.safeParse(input).success).toBe(false);
  expect(GlobalConfigSchema.safeParse(input).success).toBe(false);
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

it('provides sensitive file defaults without manager configuration', () => {
  expect(resolveManagerConfig('/project')).toHaveProperty('sensitivePaths', expect.arrayContaining([
    '.env', '.env.*', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    '*.key', '*.pem', '*.crt', '*.cer', '*.p12', '*.pfx',
  ]));
});

it('adds both configuration layers to the sensitive defaults', () => {
  doubles.global.mockReturnValue({ manager: { sensitivePaths: ['global-private'] } });
  doubles.project.mockReturnValue({ manager: { sensitivePaths: ['project-private'] } });

  expect(resolveManagerConfig('/project')).toHaveProperty('sensitivePaths', expect.arrayContaining([
    '.env', '*.pem', 'global-private', 'project-private',
  ]));
});

it('keeps sensitive defaults when both configuration layers specify empty lists', () => {
  doubles.global.mockReturnValue({ manager: { sensitivePaths: [] } });
  doubles.project.mockReturnValue({ manager: { sensitivePaths: [] } });

  expect(resolveManagerConfig('/project')).toHaveProperty('sensitivePaths', expect.arrayContaining(['.env', '.env.*', '*.key', '*.crt']));
});

it.each([{ sensitive_paths: [] }, { sensitive_paths: ['private', 'config/credentials.json'] }])('accepts additional sensitive paths in both YAML schemas: $sensitive_paths', ({ sensitive_paths }) => {
  const input = { manager: { sensitive_paths } };
  expect(ProjectConfigSchema.parse(input)).toMatchObject(input);
  expect(GlobalConfigSchema.parse(input)).toMatchObject(input);
});

it.each([null, 'private', [42], { path: 'private' }].map((sensitive_paths) => ({ sensitive_paths })))('rejects invalid sensitive path lists at both YAML boundaries: $sensitive_paths', ({ sensitive_paths }) => {
  const input = { manager: { sensitive_paths } };
  expect(ProjectConfigSchema.safeParse(input).success).toBe(false);
  expect(GlobalConfigSchema.safeParse(input).success).toBe(false);
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
