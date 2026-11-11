import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EpicStore } from '../infra/epics/store.js';
import { applyEpicVerificationResult, beginEpicVerification, finishEpic } from '../infra/epics/state.js';
import {
  epicId, epicRecord, epicVerificationResult, epicWorkspaceId, secondGoalId,
  verificationResultFor, verificationRunId, verificationStartedAt,
} from './helpers/epic-fixtures.js';

function completedRecord(requiresApply: boolean | undefined) {
  const record = epicRecord();
  const targets = epicVerificationResult().targets;
  const started = beginEpicVerification({
    ...record, targets, members: targets.map(({ repositoryDirectory, goalId }) => ({ repositoryDirectory, goalId })),
    verificationProcedure: { ...record.verificationProcedure,
      ...(requiresApply === undefined ? {} : { terraform: { requiresApply } }),
    },
  }, verificationRunId, verificationStartedAt);
  const terraform = requiresApply === true
    ? { phase: 'post_apply' as const, applyStatus: 'applied' as const, artifactReferences: ['artifact://terraform/state'] }
    : { phase: 'plan' as const, applyStatus: 'not_applied' as const, artifactReferences: ['artifact://terraform/plan'] };
  return finishEpic(applyEpicVerificationResult(started.epic, {
    ...verificationResultFor(started.run), ...(requiresApply === undefined ? {} : { terraform }),
  }));
}

describe('workspace Epic storage', () => {
  let configDirectory: string;
  let filePath: string;

  beforeEach(() => {
    const assignedDirectory = process.env.TAKT_CONFIG_DIR;
    if (assignedDirectory === undefined) throw new Error('Isolated test configuration is required');
    configDirectory = assignedDirectory;
    filePath = join(configDirectory, 'workspaces', epicWorkspaceId, 'epics', epicId, 'epic.json');
  });

  it('creates, reloads and lists the same workspace-owned record', async () => {
    const record = epicRecord();
    await new EpicStore(configDirectory, epicWorkspaceId).create(record);
    const restored = new EpicStore(configDirectory, epicWorkspaceId);
    expect(await restored.get(record.id)).toEqual(record);
    expect(await restored.list()).toEqual({ epics: [record], errors: [] });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(record);
  });

  it('keeps records from different workspaces separate', async () => {
    const first = epicRecord();
    const second = { ...first, workspaceId: '750e8400-e29b-41d4-a716-446655440000', objective: '別担当の目的' };
    await new EpicStore(configDirectory, first.workspaceId).create(first);
    await new EpicStore(configDirectory, second.workspaceId).create(second);
    expect(await new EpicStore(configDirectory, first.workspaceId).get(epicId)).toEqual(first);
    expect(await new EpicStore(configDirectory, second.workspaceId).get(epicId)).toEqual(second);
  });

  it('rejects duplicate creation without overwriting the previous definition or history', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    const original = epicRecord();
    await store.create(original);
    const before = readFileSync(filePath);
    await expect(store.create({ ...original, objective: '上書きされてはいけない目的' })).rejects.toThrow();
    expect(readFileSync(filePath)).toEqual(before);
    expect(await store.get(epicId)).toEqual(original);
  });

  it('rejects a record whose workspace differs from the store owner', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await expect(store.create({ ...epicRecord(), workspaceId: '750e8400-e29b-41d4-a716-446655440000' })).rejects.toThrow();
    expect(await store.list()).toEqual({ epics: [], errors: [] });
  });

  it('rejects persisted completion without verification evidence instead of trusting a status field', async () => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(epicRecord());
    const corrupted = JSON.stringify({ ...epicRecord(), status: 'completed' });
    writeFileSync(filePath, corrupted);
    await expect(store.get(epicId)).rejects.toThrow();
    expect((await store.list()).errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(corrupted);
  });

  it.each([
    { requiresApply: true, status: 'active' as const },
    { requiresApply: true, status: 'completed' as const },
    { requiresApply: false, status: 'active' as const },
    { requiresApply: false, status: 'completed' as const },
  ])('rejects missing Terraform records at create, save and restore with requiresApply=$requiresApply status=$status', async ({ requiresApply, status }) => {
    const original = { ...completedRecord(requiresApply), status };
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(original);
    expect(await store.get(epicId)).toEqual(original);
    const before = readFileSync(filePath);
    const invalid = { ...original, verificationRuns: original.verificationRuns.map((run) => ({
      ...run, result: { ...run.result!, terraform: undefined },
    })) };
    const newPath = join(configDirectory, 'workspaces', epicWorkspaceId, 'epics', secondGoalId, 'epic.json');
    expect(existsSync(newPath)).toBe(false);
    await expect(store.create({ ...invalid, id: secondGoalId })).rejects.toThrow();
    expect(existsSync(newPath)).toBe(false);
    expect(() => store.save(invalid)).toThrow();
    expect(readFileSync(filePath)).toEqual(before);
    expect(await store.get(epicId)).toEqual(original);
    expect(await store.list()).toEqual({ epics: [original], errors: [] });

    const corrupted = JSON.stringify(invalid);
    writeFileSync(filePath, corrupted);
    await expect(new EpicStore(configDirectory, epicWorkspaceId).get(epicId)).rejects.toThrow();
    const listed = await store.list();
    expect(listed.epics).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(corrupted);
    writeFileSync(filePath, before);
    expect(await store.get(epicId)).toEqual(original);
  });

  it('roundtrips non-Terraform completion without a Terraform result', async () => {
    const record = completedRecord(undefined);
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(record);
    expect(store.save(record)).toEqual(record);
    expect(await new EpicStore(configDirectory, epicWorkspaceId).get(epicId)).toEqual(record);
    expect(await store.list()).toEqual({ epics: [record], errors: [] });
  });

  it.each([
    { content: '{' },
    { content: 'null' },
    { content: JSON.stringify({ ...epicRecord(), id: '750e8400-e29b-41d4-a716-446655440000' }) },
    { content: JSON.stringify({ ...epicRecord(), workspaceId: '750e8400-e29b-41d4-a716-446655440000' }) },
  ])('reports corrupt or misplaced persisted state without silently losing history %#', async ({ content }) => {
    const store = new EpicStore(configDirectory, epicWorkspaceId);
    await store.create(epicRecord());
    writeFileSync(filePath, content);
    await expect(store.get(epicId)).rejects.toThrow();
    const listed = await store.list();
    expect(listed.epics).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });
});
