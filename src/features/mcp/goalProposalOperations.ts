import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import type { PendingSummary } from '../../infra/conversations/schema.js';
import type { ManagerGoalSummary } from '../../infra/goals/schema.js';
import { resolveCurrentManagerAssignment, type ManagerAssignmentIdentity } from '../manager/assignment.js';
import { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import type { ConversationCommand, OperationResult } from '../manager/conversationPort.js';
import { assertCwdAllowedByMcpRoot, errorResult, isPathAllowedByMcpRoot, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalValuePage, selectGoalValue } from './goalResponse.js';
import { pagedResult } from './response.js';
import type {
  ApproveGoalProposalInput,
  CreateGoalProposalInput,
  GetGoalProposalInput,
  ListGoalProposalsInput,
  RejectGoalProposalInput,
} from './schemas.js';

const PROPOSAL_RESULT_WAIT_MS = 120_000;

interface ProposalOwner {
  readonly identity: ManagerAssignmentIdentity;
  readonly conversationId: string;
}

async function resolveProposalOwner(cwd: string): Promise<ProposalOwner> {
  const repositoryDirectory = await resolveGitRepositoryDirectory(cwd);
  const assignment = await resolveCurrentManagerAssignment(
    { kind: 'repository', repositoryDirectory }, getGlobalConfigDir());
  const identity: ManagerAssignmentIdentity = assignment.kind === 'workspace'
    ? { kind: 'workspace', workspaceId: assignment.workspaceId }
    : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
  return { identity, conversationId: conversationId(assignment) };
}

export async function listTaktGoalProposals(
  input: ListGoalProposalsInput, deps: McpOperationDependencies,
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const owner = await resolveProposalOwner(input.cwd);
    const pending = await readAllowedPendingProposal(owner, deps.allowedProjectRoot);
    return jsonResult({
      proposals: pending === null ? [] : [{ ...proposalIdentity(owner, pending), fields: proposalFields(pending.summary) }],
      retrieval: 'Read proposal text with takt_get_goal_proposal, conversationId and a fields path, using textOffset/maxBytes for strings and offset/limit for lists.',
    });
  } catch (error) { return errorResult('Goal proposal list failed', error); }
}

export async function getTaktGoalProposal(
  input: GetGoalProposalInput, deps: McpOperationDependencies,
): Promise<CallToolResult> {
  try {
    const owner = await resolveOwnedProposal(input, deps);
    const pending = await readAllowedPendingProposal(owner, deps.allowedProjectRoot);
    if (pending === null) throw new Error(`No goal proposal is pending for ${input.cwd}`);
    const identity = proposalIdentity(owner, pending);
    if (input.path === undefined) return jsonResult({ proposal: { ...identity, summary: pending.summary } });
    const value = selectGoalValue(pending, input.path);
    if (Array.isArray(value)) {
      const offset = input.offset ?? 0;
      return pagedResult('items', value.slice(offset, offset + (input.limit ?? 50)), value.length, offset, undefined, { ...identity, path: input.path });
    }
    return jsonResult({ ...identity, path: input.path, ...goalValuePage(value, input) });
  } catch (error) { return errorResult('Goal proposal read failed', error); }
}

function proposalIdentity(owner: ProposalOwner, pending: PendingSummary) {
  return { revision: pending.revision, conversationId: owner.conversationId, repositoryDirectory: pending.repositoryDirectory };
}

function proposalFields(summary: ManagerGoalSummary) {
  const text = (path: string, value: string) => ({ path, totalBytes: Buffer.byteLength(value) });
  const list = (path: string, values: readonly string[]) => ({
    path, totalCount: values.length, totalBytes: values.reduce((total, value) => total + Buffer.byteLength(value), 0),
  });
  const optional = (path: string, value: string | undefined) => (value === undefined ? [] : [text(path, value)]);
  const specifications = summary.specifications ?? {};
  return [
    text('summary.objective', summary.objective),
    list('summary.outOfScope', summary.outOfScope),
    list('summary.acceptanceCriteria', summary.acceptanceCriteria),
    list('summary.constraints', summary.constraints),
    ...optional('summary.specifications.gherkin', specifications.gherkin),
    ...optional('summary.specifications.quint', specifications.quint),
    ...optional('summary.specifications.alloy', specifications.alloy),
    ...optional('summary.startBranch', summary.startBranch),
    ...optional('summary.integrationBranch', summary.integrationBranch),
  ];
}

// ワークスペースの会話は許可ルート外のリポジトリを含みうるため、cwd とは別に登録先を検証する。
async function readAllowedPendingProposal(owner: ProposalOwner, allowedProjectRoot: string | undefined) {
  const store = new ConversationStateStore(await resolveDaemonConfigDirectory(getGlobalConfigDir()));
  const pending = (await store.read(owner.conversationId))?.record.pending ?? null;
  if (pending !== null && !isPathAllowedByMcpRoot(pending.repositoryDirectory, allowedProjectRoot)) {
    throw new Error(`The pending goal proposal targets a repository outside the allowed project root: ${pending.repositoryDirectory}`);
  }
  return pending;
}

async function resolveOwnedProposal(
  input: { cwd: string; conversationId: string }, deps: McpOperationDependencies,
): Promise<ProposalOwner> {
  assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
  const owner = await resolveProposalOwner(input.cwd);
  if (owner.conversationId !== input.conversationId) {
    throw new Error(`The conversationId ${input.conversationId} does not own the pending goal proposal of ${input.cwd}`);
  }
  return owner;
}

async function submitProposalCommand(
  command: Extract<ConversationCommand, { kind: 'approve_summary' | 'dismiss_summary' | 'propose_summary' }>,
  identity: ManagerAssignmentIdentity, signal: AbortSignal,
): Promise<OperationResult> {
  signal.throwIfAborted();
  const client = new ConversationIpcClient(identity);
  try {
    await client.connect();
    signal.throwIfAborted();
    let wait: Promise<OperationResult> | undefined;
    const submission = await client.submit(command, (operationId) => {
      wait = new Promise<OperationResult>((resolve, reject) => {
        signal.throwIfAborted();
        const unsubscribe = client.onOutput((output) => {
          if (output.kind !== 'result' || output.operationId !== operationId) return;
          stopWaiting();
          resolve(output.result);
        });
        const onAbort = (): void => { stopWaiting(); reject(signal.reason); };
        const timer = setTimeout(() => {
          stopWaiting();
          reject(new Error(`The ${command.kind} command was accepted but its result was not observed within ${PROPOSAL_RESULT_WAIT_MS} ms`));
        }, PROPOSAL_RESULT_WAIT_MS);
        const stopWaiting = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          unsubscribe();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    if (submission.kind === 'error') throw new Error(`${submission.code}: ${submission.message}`);
    return await wait!;
  } finally { client.close(); }
}

async function submitOwnedProposalCommand(
  input: ApproveGoalProposalInput | RejectGoalProposalInput, deps: McpOperationDependencies,
  signal: AbortSignal,
  buildCommand: (owner: ProposalOwner) => Extract<ConversationCommand, { kind: 'approve_summary' | 'dismiss_summary' }>,
): Promise<OperationResult> {
  const owner = await resolveOwnedProposal(input, deps);
  if (deps.allowedProjectRoot !== undefined) {
    // revision ごとに保留中の案は一つなので、検査した案と daemon が扱う案を revision で結び付ける。
    const pending = await readAllowedPendingProposal(owner, deps.allowedProjectRoot);
    if (pending?.revision !== input.revision) return { kind: 'error', code: 'stale_summary', message: 'The displayed proposal has changed' };
  }
  return submitProposalCommand(buildCommand(owner), owner.identity, signal);
}

export async function approveTaktGoalProposal(
  input: ApproveGoalProposalInput, deps: McpOperationDependencies, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const result = await submitOwnedProposalCommand(input, deps, signal,
      (owner) => ({ kind: 'approve_summary', revision: input.revision, conversationId: owner.conversationId, requirePending: true }));
    if (result.kind === 'error') throw new Error(`${result.code}: ${result.message}`);
    if (result.kind !== 'goal_registered') throw new Error(`Unexpected goal registration result: ${result.kind}`);
    return jsonResult({ revision: input.revision, goal: result.goal });
  } catch (error) { return errorResult('Goal proposal approval failed', error); }
}

export async function rejectTaktGoalProposal(
  input: RejectGoalProposalInput, deps: McpOperationDependencies, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const result = await submitOwnedProposalCommand(input, deps, signal,
      (owner) => ({ kind: 'dismiss_summary', revision: input.revision, conversationId: owner.conversationId }));
    if (result.kind === 'error') throw new Error(`${result.code}: ${result.message}`);
    if (result.kind !== 'notice') throw new Error(`Unexpected goal registration dismissal result: ${result.kind}`);
    return jsonResult({ revision: input.revision, notice: result.message });
  } catch (error) { return errorResult('Goal proposal rejection failed', error); }
}

export async function createTaktGoalProposal(
  input: CreateGoalProposalInput, deps: McpOperationDependencies, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const owner = await resolveProposalOwner(input.cwd);
    const repositoryDirectory = await resolveGitRepositoryDirectory(input.cwd);
    if (!isPathAllowedByMcpRoot(repositoryDirectory, deps.allowedProjectRoot)) {
      throw new Error(`The goal proposal targets a repository outside the allowed project root: ${repositoryDirectory}`);
    }
    const result = await submitProposalCommand(
      { kind: 'propose_summary', conversationId: owner.conversationId, repositoryDirectory, summary: input.summary },
      owner.identity, signal);
    if (result.kind === 'error') throw new Error(`${result.code}: ${result.message}`);
    if (result.kind !== 'notice') throw new Error(`Unexpected goal proposal creation result: ${result.kind}`);
    const pending = await readAllowedPendingProposal(owner, deps.allowedProjectRoot);
    if (pending === null) throw new Error('The goal proposal was accepted but no pending proposal could be read back');
    return jsonResult({ proposal: { ...proposalIdentity(owner, pending), fields: proposalFields(pending.summary) } });
  } catch (error) { return errorResult('Goal proposal creation failed', error); }
}
