import type { WorkflowState, WorkflowSystemInput } from '../../../core/models/types.js';
import { PrCiFailureSchema, PrCiRerunSchema, type PrCiFailure } from '../../../core/workflow/system/pr-ci.js';
import type { PrStatusFetchOptions } from '../../../core/workflow/system/pr-execution-context.js';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { resolveWorkflowStateReference } from '../../../core/workflow/state/workflow-state-access.js';
import { parseWorkflowStateReference } from '../../../core/models/workflow-state-reference.js';
import { getGitProvider } from '../../git/index.js';

const FIX_PUSH_STEP = 'push_ci_fix';
const INVESTIGATION_STEP = 'investigate_ci';

function referenceValue(reference: string, state: WorkflowState): unknown {
  return resolveWorkflowStateReference(reference.slice(1, -1).replace(':', '.'), state);
}

export function prCiStatusOptions(
  input: Extract<WorkflowSystemInput, { type: 'pr_status' }>,
  state: WorkflowState | undefined,
  options: PrStatusFetchOptions,
): PrStatusFetchOptions {
  if (input.rerun_from === undefined) return options;
  if (!state) throw new Error('CI rerun reference requires workflow state');
  const reference = input.rerun_from.slice(1, -1).replace(':', '.');
  const parsed = parseWorkflowStateReference(reference);
  // Before the optional rerun step has executed, ordinary polling still applies.
  if (parsed.root === 'effect' && !state.effectResults.has(parsed.scope!)) return options;
  return { ...options, rerun: PrCiRerunSchema.parse(referenceValue(input.rerun_from, state)) };
}

export async function resolvePrCiFailure(
  options: SystemStepServicesOptions,
  input: Extract<WorkflowSystemInput, { type: 'pr_ci_failure' }>,
  state: WorkflowState | undefined,
  fetchOptions: PrStatusFetchOptions,
) {
  const context = options.prExecutionContext;
  if (!context || !state) throw new Error('CI failure input requires PR context and workflow state');
  const headSha = referenceValue(input.head_sha, state);
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('CI failure target requires a HEAD SHA');
  const fixRounds = state.stepIterations.get(FIX_PUSH_STEP) ?? 0;
  const rerunResults = [...state.effectResults.values()]
    .filter((effects) => Object.hasOwn(effects, 'rerun_ci'))
    .map((effects) => effects.rerun_ci);
  const rerunCount = rerunResults.length;
  const rerunResult = rerunResults.at(-1);
  const recoveryError = typeof rerunResult === 'object' && rerunResult !== null && 'error' in rerunResult
    ? rerunResult.error : undefined;
  const status = state.systemContexts.get('wait_ci')?.status;
  const headChangeReason = typeof status === 'object' && status !== null
    && 'rerunHeadChanged' in status && status.rerunHeadChanged === true
    && 'rerunHeadChangeReason' in status ? status.rerunHeadChangeReason
    : typeof rerunResult === 'object' && rerunResult !== null && 'headChanged' in rerunResult
      && rerunResult.headChanged === true ? recoveryError : undefined;
  let failure: PrCiFailure;
  if (typeof headChangeReason === 'string') {
    const previous = PrCiFailureSchema.parse(state.systemContexts.get('collect_ci_failure')?.failure);
    if (previous.number !== context.prNumber || previous.headSha !== headSha) {
      throw new Error('Saved CI evidence does not match the investigation target');
    }
    failure = { ...previous, complete: false,
      unavailable: [...previous.unavailable, { name: 'CI', reason: headChangeReason }] };
  } else {
    try {
      const provider = options.gitProvider ?? getGitProvider();
      if (!provider.fetchPrCiFailure) throw new Error('CI failure evidence is not supported by this Git provider');
      const rerun = typeof rerunResult === 'object' && rerunResult !== null && 'success' in rerunResult && rerunResult.success === true
        ? PrCiRerunSchema.parse(Reflect.get(rerunResult, 'rerun')) : undefined;
      failure = PrCiFailureSchema.parse(await provider.fetchPrCiFailure(context.prNumber, headSha, options.projectCwd,
        rerun === undefined ? fetchOptions : { ...fetchOptions, rerun }));
      if (failure.number !== context.prNumber || failure.headSha !== headSha) throw new Error('CI evidence does not match the requested PR and HEAD');
    } catch (error) {
      fetchOptions.signal?.throwIfAborted();
      failure = { number: context.prNumber, headSha, complete: false, checks: [],
        unavailable: [{ name: 'CI', reason: error instanceof Error ? error.message : String(error) }] };
    }
  }
  return { ...failure, fixRounds, rerunCount, recoveryError,
    details: JSON.stringify({
      checks: failure.checks.map(({ name, run, jobs }) => ({
        name, run, jobs: jobs.map(({ id, name: jobName, url }) => ({ id, name: jobName, url })),
      })),
      unavailable: failure.unavailable,
      recoveryError,
    }) };
}

export async function rerunCiEffect(
  options: SystemStepServicesOptions, payload: Record<string, unknown>, state: WorkflowState,
): Promise<Record<string, unknown>> {
  try {
    const context = options.prExecutionContext;
    const failure = PrCiFailureSchema.parse(payload.failure);
    if (!context || payload.pr !== context.prNumber || failure.number !== context.prNumber) {
      throw new Error('CI rerun must target the current PR');
    }
    if (state.structuredOutputs.get(INVESTIGATION_STEP)?.verdict !== 'external') {
      throw new Error('CI rerun requires an external cause established by investigation');
    }
    const rerunAttempted = [...state.effectResults.values()].some((effects) => Object.hasOwn(effects, 'rerun_ci'));
    if ((state.stepIterations.get(state.currentStep) ?? 0) > 1 || rerunAttempted) {
      throw new Error('CI rerun budget is exhausted');
    }
    const status = state.systemContexts.get('wait_ci')?.status;
    if (typeof status !== 'object' || status === null || !('headSha' in status) || status.headSha !== failure.headSha) {
      throw new Error('CI rerun evidence is stale');
    }
    if (!failure.complete || failure.unavailable.length > 0 || failure.checks.length === 0
      || failure.checks.some(({ run, jobs }) => run.headSha !== failure.headSha
        || jobs.length === 0 || jobs.some((job) => job.log === undefined || job.log.trim().length === 0))) {
      throw new Error('CI rerun requires complete failure evidence');
    }
    const provider = options.gitProvider ?? getGitProvider();
    if (!provider.rerunPrCi) throw new Error('CI rerun is not supported by this Git provider');
    if (!provider.fetchPrStatus) throw new Error('PR status is not supported by this Git provider');
    const current = await provider.fetchPrStatus(context.prNumber, options.projectCwd, { signal: options.abortSignal });
    if (current.number !== context.prNumber) throw new Error('PR status response does not match the requested PR');
    if (current.headSha !== failure.headSha) {
      return { success: false, failed: true, headChanged: true,
        error: `PR HEAD changed from ${failure.headSha} to ${current.headSha} before CI rerun` };
    }
    const result = await provider.rerunPrCi(failure, options.projectCwd, { signal: options.abortSignal });
    return { ...result, rerun: { number: result.number, headSha: result.headSha, runs: result.runs } };
  } catch (error) {
    options.abortSignal?.throwIfAborted();
    return { success: false, failed: true, error: error instanceof Error ? error.message : String(error) };
  }
}
