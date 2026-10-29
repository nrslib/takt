import {
  buildLogAccessContinuation,
  executePhase1LogRequest,
  LOG_BUDGET_EXHAUSTED_CONTINUATION,
  parsePhase1LogRequest,
  PHASE1_LOG_MAX_REQUESTS,
  PHASE1_LOG_TOTAL_BYTE_BUDGET,
} from '../../dist/core/workflow/phase1-log-access.js';
import {
  createCliReviewSession,
  mergeCliReviewConfig,
  prepareWorkingDirectory,
  rewriteWorkingDirectoryPaths,
} from './cli-review.mjs';

function executionReference(prompt) {
  const path = prompt.match(/^- (?:Path|パス): (.+)$/m)?.[1];
  const byteSizeText = prompt.match(/^- (?:Size in bytes|バイト数): (\d+)$/m)?.[1];
  if (path === undefined || byteSizeText === undefined) throw new Error('Phase 1 execution reference is missing');
  return { path, byteSize: Number(byteSizeText), stepName: 'review', stepIteration: 1 };
}

export default class Phase1ExecutionLogProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.dependencies = { prepareWorkingDirectory, createCliReviewSession, ...dependencies };
  }

  id() {
    return `phase1-execution-log:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, context, options = {}) {
    let workingDirectory;
    try {
      const config = mergeCliReviewConfig(this.config, context);
      workingDirectory = this.dependencies.prepareWorkingDirectory(config);
      const isolatedPrompt = rewriteWorkingDirectoryPaths(prompt, workingDirectory);
      const reference = executionReference(isolatedPrompt);
      const session = this.dependencies.createCliReviewSession(config, {
        cwd: workingDirectory.cwd,
        abortSignal: options.abortSignal,
      });
      let input = isolatedPrompt;
      let requestsRemaining = PHASE1_LOG_MAX_REQUESTS;
      let bytesRemaining = PHASE1_LOG_TOTAL_BYTE_BUDGET;
      let exhaustionNoticeSent = false;
      for (;;) {
        const output = await session.run(input);
        const parsed = parsePhase1LogRequest(output.trim());
        if (parsed.kind === 'none') return { output };
        if (parsed.kind === 'invalid') return { error: parsed.message };
        if (requestsRemaining === 0 || bytesRemaining === 0) {
          if (exhaustionNoticeSent) return { error: 'The Phase 1 execution record read budget is exhausted.' };
          exhaustionNoticeSent = true;
          input = LOG_BUDGET_EXHAUSTED_CONTINUATION;
          continue;
        }
        const result = await executePhase1LogRequest(
          reference,
          parsed.request,
          Math.min(parsed.request.limit, bytesRemaining),
        );
        requestsRemaining--;
        bytesRemaining -= Buffer.byteLength(result.content);
        input = buildLogAccessContinuation(parsed.request, result);
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
