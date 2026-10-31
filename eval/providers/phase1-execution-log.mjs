import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auditPhase2, snapshotFiles } from './phase1-execution-log-audit.mjs';
import { reportPhaseEventTools } from '../../dist/core/workflow/report-phase-tools.js';
import {
  createCliReviewSession, mergeCliReviewConfig, prepareWorkingDirectory, rewriteWorkingDirectoryPaths,
} from './cli-review.mjs';

export function executionReference(prompt) {
  const path = prompt.match(/^- (?:Path|パス): (.+)$/m)?.[1];
  const byteSizeText = prompt.match(/^- (?:Size in bytes|バイト数): (\d+)$/m)?.[1];
  if (path === undefined || byteSizeText === undefined) throw new Error('Phase 1 execution reference is missing');
  return { path, byteSize: Number(byteSizeText) };
}

export default class Phase1ExecutionLogProvider {
  constructor(options = {}, dependencies = {}) {
    this.config = options.config ?? {};
    this.dependencies = { prepareWorkingDirectory, createCliReviewSession, snapshotFiles, ...dependencies };
  }
  id() { return `phase1-execution-log:${this.config.cli}:${this.config.model}`; }

  async callApi(prompt, context, options = {}) {
    let workingDirectory;
    const events = [];
    const metadata = { phase2_events: events };
    let phase = 1;
    try {
      const config = mergeCliReviewConfig(this.config, context);
      workingDirectory = this.dependencies.prepareWorkingDirectory(config);
      const isolatedPrompt = rewriteWorkingDirectoryPaths(prompt, workingDirectory);
      const reference = executionReference(isolatedPrompt);
      const session = this.dependencies.createCliReviewSession(config, {
        cwd: workingDirectory.cwd, abortSignal: options.abortSignal,
        allowedTools: reportPhaseEventTools(config.cli),
        onEvent: (event) => { if (phase === 2) events.push(event); },
      });
      const carryover = context?.vars?.phase1_session_prompt;
      if (carryover) {
        metadata.phase1_response = await session.run(carryover);
        metadata.resumed = true;
      }
      const snapshot = () => ({
        ...this.dependencies.snapshotFiles(workingDirectory.cwd),
        executionRecord: createHash('sha256').update(readFileSync(reference.path)).digest('hex'),
      });
      const before = snapshot();
      phase = 2;
      const output = await session.run(isolatedPrompt);
      const after = snapshot();
      metadata.phase2_audit = auditPhase2({ events, cli: config.cli, reference, cwd: workingDirectory.cwd, before, after });
      return { output, metadata };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), metadata };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
