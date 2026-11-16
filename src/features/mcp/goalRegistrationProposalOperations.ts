import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { resolveCurrentManagerAssignment, type ManagerAssignmentIdentity } from '../manager/assignment.js';
import { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import type { ConversationCommand, OperationResult } from '../manager/conversationPort.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type {
  ApproveGoalRegistrationInput,
  ListGoalRegistrationProposalsInput,
  RejectGoalRegistrationInput,
} from './schemas.js';

const REGISTRATION_RESULT_WAIT_MS = 120_000;

interface RegistrationOwner {
  readonly identity: ManagerAssignmentIdentity;
  readonly conversationId: string;
}

async function resolveRegistrationOwner(cwd: string): Promise<RegistrationOwner> {
  const repositoryDirectory = await resolveGitRepositoryDirectory(cwd);
  const assignment = await resolveCurrentManagerAssignment(
    { kind: 'repository', repositoryDirectory }, getGlobalConfigDir());
  const identity: ManagerAssignmentIdentity = assignment.kind === 'workspace'
    ? { kind: 'workspace', workspaceId: assignment.workspaceId }
    : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
  return { identity, conversationId: conversationId(assignment) };
}

export async function listTaktGoalRegistrationProposals(
  input: ListGoalRegistrationProposalsInput, deps: McpOperationDependencies,
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const owner = await resolveRegistrationOwner(input.cwd);
    const store = new ConversationStateStore(await resolveDaemonConfigDirectory(getGlobalConfigDir()));
    const pending = (await store.read(owner.conversationId))?.record.pending ?? null;
    return jsonResult({ proposals: pending === null ? [] : [{ ...pending, conversationId: owner.conversationId }] });
  } catch (error) { return errorResult('Goal registration proposal list failed', error); }
}

async function submitRegistrationCommand(
  command: Extract<ConversationCommand, { kind: 'approve_summary' | 'dismiss_summary' }>,
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
          reject(new Error(`The ${command.kind} command was accepted but its result was not observed within ${REGISTRATION_RESULT_WAIT_MS} ms`));
        }, REGISTRATION_RESULT_WAIT_MS);
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

async function submitOwnedRegistrationCommand(
  input: ApproveGoalRegistrationInput | RejectGoalRegistrationInput, deps: McpOperationDependencies,
  signal: AbortSignal,
  buildCommand: (owner: RegistrationOwner) => Extract<ConversationCommand, { kind: 'approve_summary' | 'dismiss_summary' }>,
): Promise<OperationResult> {
  assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
  const owner = await resolveRegistrationOwner(input.cwd);
  if (owner.conversationId !== input.conversationId) {
    throw new Error(`The conversationId ${input.conversationId} does not own the pending registration proposal of ${input.cwd}`);
  }
  return submitRegistrationCommand(buildCommand(owner), owner.identity, signal);
}

export async function approveTaktGoalRegistration(
  input: ApproveGoalRegistrationInput, deps: McpOperationDependencies, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const result = await submitOwnedRegistrationCommand(input, deps, signal,
      (owner) => ({ kind: 'approve_summary', revision: input.revision, conversationId: owner.conversationId }));
    if (result.kind === 'error') throw new Error(`${result.code}: ${result.message}`);
    if (result.kind !== 'goal_registered') throw new Error(`Unexpected goal registration result: ${result.kind}`);
    return jsonResult({ revision: input.revision, goal: result.goal });
  } catch (error) { return errorResult('Goal registration approval failed', error); }
}

export async function rejectTaktGoalRegistration(
  input: RejectGoalRegistrationInput, deps: McpOperationDependencies, signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const result = await submitOwnedRegistrationCommand(input, deps, signal,
      (owner) => ({ kind: 'dismiss_summary', revision: input.revision, conversationId: owner.conversationId }));
    if (result.kind === 'error') throw new Error(`${result.code}: ${result.message}`);
    if (result.kind !== 'notice') throw new Error(`Unexpected goal registration dismissal result: ${result.kind}`);
    return jsonResult({ revision: input.revision, notice: result.message });
  } catch (error) { return errorResult('Goal registration rejection failed', error); }
}
