import { beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { confirmationKeys, confirmationPayload, goalRecord, goalInput, signedConfirmation } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), unlink: vi.fn(), get: vi.fn(), list: vi.fn(), config: vi.fn() }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, unlinkSync: doubles.unlink }));
vi.mock('../infra/config/paths.js', () => ({ getGlobalConfigDir: doubles.config }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: () => ({}) }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn(), readPrivateFileState: doubles.read, writeNewPrivateFileWithMode: doubles.write }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; list = doubles.list; } }));
import { getRegisteredGoal, listRegisteredGoals, saveGoalRegistration } from '../infra/goals/registration.js';

const keys = confirmationKeys();
let files: Map<string, string>;
let goal: Goal;
function register(cwd = '/project') {
  const input = { cwd, ...goalInput(), confirmation: signedConfirmation(confirmationPayload(cwd), keys.privateKey) };
  return saveGoalRegistration(input, keys.publicKey, goal);
}
beforeEach(() => {
  vi.resetAllMocks();
  files = new Map();
  goal = goalRecord();
  doubles.config.mockReturnValue('/host-config');
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [structuredClone(goal)], errors: [] }));
  doubles.write.mockImplementation((path: string, content: string) => {
    if (files.has(path)) throw new Error('already exists');
    files.set(path, content);
  });
  doubles.read.mockImplementation((path: string) => files.has(path) ? { content: Buffer.from(files.get(path)!) } : { state: { exists: false } });
  doubles.unlink.mockImplementation((path: string) => files.delete(path));
});

it('restores a signed registration and preserves mutable runtime state', async () => {
  register();
  goal.events = [{ taskName: 'task', runSlug: 'run', processed: false, result: { success: true, interrupted: false } }];
  expect(await getRegisteredGoal('/project', goal.id)).toEqual(goal);
  expect(doubles.write).toHaveBeenCalledWith(expect.any(String), expect.any(String), 0o600);
  expect([...files.values()][0]).not.toContain('PRIVATE KEY');
});

it('persists only the derived public key even when the host supplies private key material', async () => {
  const input = { cwd: '/project', ...goalInput(), confirmation: signedConfirmation(confirmationPayload('/project'), keys.privateKey) };
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  saveGoalRegistration(input, privatePem, goal);
  const saved = [...files.values()][0]!;
  expect(saved).not.toContain('PRIVATE KEY');
  expect(JSON.parse(saved).publicKey).toBe(keys.publicKey);
  expect(await getRegisteredGoal('/project', goal.id)).toEqual(goal);
});

it.each(['objective', 'branch', 'confirmation', 'missing evidence', 'signature', 'copied project'] as const)('rejects %s and returns an individual diagnostic', async (change) => {
  register();
  if (change === 'objective') goal.objective = 'JSONを出力する';
  if (change === 'branch') goal.startBranch = 'release';
  if (change === 'confirmation') goal.confirmation.confirmedBy = 'unverified';
  if (change === 'missing evidence') files.clear();
  if (change === 'signature') {
    const [path, content] = [...files.entries()][0]!;
    const evidence = JSON.parse(content) as { input: { confirmation: { signature: string } } };
    evidence.input.confirmation.signature = 'AA==';
    files.set(path, JSON.stringify(evidence));
  }
  if (change === 'copied project') {
    const content = [...files.values()][0]!;
    const paths = [...files.keys()];
    register('/other-project');
    const copiedPath = [...files.keys()].find((path) => !paths.includes(path))!;
    files.set(copiedPath, content);
    await expect(getRegisteredGoal('/other-project', goal.id)).rejects.toThrow();
    return;
  }
  await expect(getRegisteredGoal('/project', goal.id)).rejects.toThrow();
  const result = await listRegisteredGoals('/project');
  expect(result.goals).toEqual([]);
  expect(result.errors).toEqual([{ goalId: goal.id, error: expect.any(Error) }]);
});

it('separates the same goal ID by project and refuses to overwrite existing evidence', async () => {
  register('/project-a');
  register('/project-b');
  expect(files.size).toBe(2);
  expect(await getRegisteredGoal('/project-a', goal.id)).toEqual(goal);
  expect(await getRegisteredGoal('/project-b', goal.id)).toEqual(goal);
  const original = new Map(files);
  expect(() => register('/project-a')).toThrow();
  expect(files).toEqual(original);
});

it.each(['/project/config', '/project/..config'])('refuses project-local trust storage at %s', async (config) => {
  doubles.config.mockReturnValue(config);
  expect(() => register()).toThrow();
  await expect(getRegisteredGoal('/project', goal.id)).rejects.toThrow();
  expect(doubles.write).not.toHaveBeenCalled();
});

it('compensates only its unchanged registration evidence', () => {
  const remove = register();
  remove();
  expect(files.size).toBe(0);
  const changedRemove = register();
  files.set([...files.keys()][0]!, '{}');
  expect(() => changedRemove()).toThrow();
  expect(files.size).toBe(1);
});

it('removes its evidence when publication reports failure after saving it', () => {
  doubles.write.mockImplementation((path: string, content: string) => { files.set(path, content); throw new Error('publication failed'); });
  expect(() => register()).toThrow('publication failed');
  expect(files.size).toBe(0);
  doubles.write.mockImplementation((path: string, content: string) => files.set(path, content));
  register();
  expect(files.size).toBe(1);
});
