import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readWorkspace, type Workspace } from '../config/global/workspaceRegistry.js';
import { resolveGitRepositoryDirectory } from '../task/repositoryDirectory.js';
import {
  EpicContextSchema, EpicCreateSchema, EpicDefinitionChangeSchema, EpicMemberChangeSchema,
  EpicMemberReplaceSchema, EpicOwnerSchema, EpicReasonSchema, EpicResultInputSchema,
  type Epic, type EpicChange, type EpicContext, type EpicMember, type EpicOwner, type EpicView,
} from './schema.js';
import { EpicStore } from './store.js';
import { withWorkspaceEpicLock } from './lock.js';
import { resolveEpicMember, resolveEpicTargets } from './targets.js';
import { memberKey, sameTargets } from './targetIdentity.js';
import {
  abortEpicState, applyEpicVerificationResult, assertEpicMutable, beginEpicVerification,
  epicDefinition, epicVerificationRecovery, epicView, finishEpic, reviseEpic,
} from './state.js';

async function requireWorkspace(owner: EpicOwner): Promise<Workspace> {
  const workspace = await readWorkspace(owner.globalConfigDirectory, owner.workspaceId);
  if (workspace === undefined) throw new Error(`Workspace does not exist: ${owner.workspaceId}`);
  return workspace;
}

async function requireWorkspaceForEpicUpdate(owner: EpicOwner, epic: Epic): Promise<Workspace> {
  const workspace = await requireWorkspace(owner);
  if (epic.status === 'completed' && epic.members.some((member) => !workspace.repositoryDirectories.includes(member.repositoryDirectory))) {
    throw new Error('Restore workspace assignment before changing a completed Epic that references a removed repository');
  }
  return workspace;
}

function changeRecord(kind: EpicChange['kind'], reason: string): EpicChange {
  return { kind, reason, recordedAt: new Date().toISOString() };
}

async function withEpic<T>(context: EpicContext, action: (store: EpicStore, epic: Epic) => Promise<T>): Promise<T> {
  return withWorkspaceEpicLock(context.globalConfigDirectory, context.workspaceId, async () => {
    const store = new EpicStore(context.globalConfigDirectory, context.workspaceId);
    return action(store, await store.get(context.epicId));
  });
}

async function synchronizeTargets(store: EpicStore, epic: Epic, workspace: Workspace, reason: string): Promise<{ epic: Epic; error?: Error }> {
  let targets;
  try {
    targets = await resolveEpicTargets(workspace, epic.members);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (epic.status !== 'aborted' && (epic.targets.length > 0 || epicView(epic).currentEvidence !== undefined || epicView(epic).runningVerification !== undefined)) {
      epic = store.save(reviseEpic(epic, { targets: [] }, changeRecord('targets', `Cannot resolve current member targets: ${error.message}`)));
    }
    return { epic, error };
  }
  if (!sameTargets(epic.targets, targets)) epic = store.save(reviseEpic(epic, { targets }, changeRecord('targets', reason)));
  return { epic };
}

async function storedMember(epic: Epic, input: EpicMember): Promise<EpicMember> {
  const direct = epic.members.find((member) => memberKey(member) === memberKey(input));
  if (direct !== undefined) return direct;
  const normalized = { ...input, repositoryDirectory: await resolveGitRepositoryDirectory(input.repositoryDirectory) };
  const found = epic.members.find((member) => memberKey(member) === memberKey(normalized));
  if (found === undefined) throw new Error('Epic member does not exist');
  return found;
}

export async function createEpic(input: unknown) {
  const request = EpicCreateSchema.parse(input);
  return withWorkspaceEpicLock(request.globalConfigDirectory, request.workspaceId, async () => {
    await requireWorkspace(request);
    const epic: Epic = {
      id: randomUUID(), workspaceId: request.workspaceId, objective: request.objective,
      acceptanceCriteria: request.acceptanceCriteria, verificationProcedure: request.verificationProcedure,
      revision: 1, status: 'active', members: [], targets: [], verificationRuns: [],
      changes: [{ ...changeRecord('created', request.reason), definition: {
        objective: request.objective, acceptanceCriteria: request.acceptanceCriteria, verificationProcedure: request.verificationProcedure,
      } }],
    };
    return epicView(await new EpicStore(request.globalConfigDirectory, request.workspaceId).create(epic));
  });
}

export async function getEpic(input: unknown) {
  const request = EpicContextSchema.parse(input);
  return epicView(await new EpicStore(request.globalConfigDirectory, request.workspaceId).get(request.epicId));
}

const EpicPageSchema = z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().nonnegative() }).strict();
type EpicPage = z.infer<typeof EpicPageSchema>;

export function listEpics(input: unknown): Promise<EpicView[]>;
export function listEpics(input: unknown, page: EpicPage): Promise<{ epics: EpicView[]; totalCount: number; offset: number }>;
export async function listEpics(input: unknown, page?: EpicPage) {
  const request = EpicOwnerSchema.parse(input);
  const selection = page === undefined ? undefined : EpicPageSchema.parse(page);
  const result = await new EpicStore(request.globalConfigDirectory, request.workspaceId).list(selection);
  if (result.errors.length > 0) throw new AggregateError(result.errors.map(({ error }) => error), 'Cannot read workspace Epics');
  const epics = result.epics.map(epicView);
  return selection === undefined ? epics : { epics, totalCount: result.totalCount, offset: selection.offset };
}

export async function addEpicMember(input: unknown) {
  const request = EpicMemberChangeSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    const member = await resolveEpicMember(await requireWorkspaceForEpicUpdate(request, epic), request.member);
    if (epic.members.some((entry) => memberKey(entry) === memberKey(member))) throw new Error('Epic member already exists');
    return epicView(store.save(reviseEpic(epic, { members: [...epic.members, member] }, {
      ...changeRecord('member_added', request.reason), member,
    })));
  });
}

export async function removeEpicMember(input: unknown) {
  const request = EpicMemberChangeSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    await requireWorkspaceForEpicUpdate(request, epic);
    const member = await storedMember(epic, request.member);
    return epicView(store.save(reviseEpic(epic, {
      members: epic.members.filter((entry) => memberKey(entry) !== memberKey(member)),
      targets: epic.targets.filter((target) => memberKey(target) !== memberKey(member)),
    }, { ...changeRecord('member_removed', request.reason), member })));
  });
}

export async function replaceEpicMember(input: unknown) {
  const request = EpicMemberReplaceSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    const member = await storedMember(epic, request.member);
    const replacement = await resolveEpicMember(await requireWorkspaceForEpicUpdate(request, epic), request.replacement);
    if (epic.members.some((entry) => memberKey(entry) === memberKey(replacement))) throw new Error('Replacement is already an Epic member');
    return epicView(store.save(reviseEpic(epic, {
      members: epic.members.map((entry) => memberKey(entry) === memberKey(member) ? replacement : entry),
      targets: epic.targets.filter((target) => memberKey(target) !== memberKey(member)),
    }, { ...changeRecord('member_replaced', request.reason), member, replacement })));
  });
}

export async function updateEpicDefinition(input: unknown) {
  const request = EpicDefinitionChangeSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    if (isDeepStrictEqual({ ...epicDefinition(epic), ...request.changes }, epicDefinition(epic))) return epicView(epic);
    await requireWorkspaceForEpicUpdate(request, epic);
    return epicView(store.save(reviseEpic(epic, request.changes, changeRecord('definition', request.reason))));
  });
}

export async function refreshEpicTargets(input: unknown) {
  const request = EpicReasonSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    const current = await synchronizeTargets(store, epic, await requireWorkspaceForEpicUpdate(request, epic), request.reason);
    if (current.error !== undefined) throw current.error;
    return epicView(current.epic);
  });
}

export async function startEpicVerification(input: unknown) {
  const request = EpicContextSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    const current = await synchronizeTargets(store, epic, await requireWorkspaceForEpicUpdate(request, epic), 'Member completion targets changed before verification');
    if (current.error !== undefined) throw current.error;
    const started = beginEpicVerification(current.epic, randomUUID(), new Date().toISOString());
    store.save(started.epic);
    return started.run;
  });
}

export async function recordEpicVerificationResult(input: unknown) {
  const request = EpicResultInputSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    // 入力の不一致による拒否では、対象の同期も含め保存状態を変えない。
    const candidate = applyEpicVerificationResult(epic, request.result);
    if (epic.status === 'aborted') return epicView(store.save(candidate));
    const current = await synchronizeTargets(store, epic, await requireWorkspaceForEpicUpdate(request, epic), 'Member completion targets changed before result registration');
    const next = current.epic === epic ? candidate : applyEpicVerificationResult(current.epic, request.result);
    return epicView(store.save(next));
  });
}

export async function completeEpic(input: unknown) {
  const request = EpicContextSchema.parse(input);
  return withEpic(request, async (store, epic) => {
    assertEpicMutable(epic);
    const current = await synchronizeTargets(store, epic, await requireWorkspaceForEpicUpdate(request, epic), 'Member completion targets changed before completion');
    if (current.error !== undefined) throw current.error;
    return epicView(store.save(finishEpic(current.epic)));
  });
}

export async function abortEpic(input: unknown) {
  const request = EpicReasonSchema.parse(input);
  return withEpic(request, async (store, epic) => epicView(store.save(abortEpicState(epic, changeRecord('aborted', request.reason)))));
}

export async function getEpicVerificationRecovery(input: unknown) {
  const request = EpicContextSchema.parse(input);
  return epicVerificationRecovery(await new EpicStore(request.globalConfigDirectory, request.workspaceId).get(request.epicId));
}

export async function assertRepositoryHasNoActiveEpics(owner: EpicOwner, repositoryDirectory: string): Promise<void> {
  const epics = await listEpics(owner);
  const references = epics.filter((epic) => epic.status === 'active' && epic.members.some((member) => member.repositoryDirectory === repositoryDirectory));
  if (references.length > 0) throw new Error(`Repository is referenced by active Epics: ${references.map(({ id }) => id).join(', ')}. Remove the member reference, complete or abort the Epic first.`);
}
