/**
 * Builds RunAgentOptions for different execution phases.
 *
 * Centralizes the option construction logic that was previously
 * scattered across PieceEngine methods.
 */

import { join } from 'node:path';
import type { PieceMovement, PieceState, Language } from '../../models/types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { PhaseRunnerContext } from '../phase-runner.js';
import type { PieceEngineOptions, PhaseName } from '../types.js';

export class OptionsBuilder {
  constructor(
    private readonly engineOptions: PieceEngineOptions,
    private readonly getCwd: () => string,
    private readonly getProjectCwd: () => string,
    private readonly getSessionId: (agent: string) => string | undefined,
    private readonly getReportDir: () => string,
    private readonly getLanguage: () => Language | undefined,
    private readonly getPieceMovements: () => ReadonlyArray<{ name: string; description?: string }>,
    private readonly getPieceName: () => string,
    private readonly getPieceDescription: () => string | undefined,
  ) {}

  /** Build common RunAgentOptions shared by all phases */
  buildBaseOptions(step: PieceMovement): RunAgentOptions {
    const movements = this.getPieceMovements();
    const currentIndex = movements.findIndex((m) => m.name === step.name);
    const currentPosition = currentIndex >= 0 ? `${currentIndex + 1}/${movements.length}` : '?/?';

    return {
      cwd: this.getCwd(),
      agentPath: step.agentPath,
      provider: step.provider ?? this.engineOptions.provider,
      model: step.model ?? this.engineOptions.model,
      permissionMode: step.permissionMode,
      language: this.getLanguage(),
      onStream: this.engineOptions.onStream,
      onPermissionRequest: this.engineOptions.onPermissionRequest,
      onAskUserQuestion: this.engineOptions.onAskUserQuestion,
      bypassPermissions: this.engineOptions.bypassPermissions,
      pieceMeta: {
        pieceName: this.getPieceName(),
        pieceDescription: this.getPieceDescription(),
        currentMovement: step.name,
        movementsList: movements,
        currentPosition,
      },
    };
  }

  /** Build RunAgentOptions for Phase 1 (main execution) */
  buildAgentOptions(step: PieceMovement): RunAgentOptions {
    // Phase 1: exclude Write from allowedTools when movement has report config AND edit is NOT enabled
    // (If edit is enabled, Write is needed for code implementation even if report exists)
    // Note: edit defaults to undefined, so check !== true to catch both false and undefined
    const allowedTools = step.report && step.edit !== true
      ? step.allowedTools?.filter((t) => t !== 'Write')
      : step.allowedTools;

    // Skip session resume when cwd !== projectCwd (worktree execution) to avoid cross-directory contamination
    const shouldResumeSession = step.session !== 'refresh' && this.getCwd() === this.getProjectCwd();

    return {
      ...this.buildBaseOptions(step),
      sessionId: shouldResumeSession ? this.getSessionId(step.agent ?? step.name) : undefined,
      allowedTools,
    };
  }

  /** Build RunAgentOptions for session-resume phases (Phase 2, Phase 3) */
  buildResumeOptions(
    step: PieceMovement,
    sessionId: string,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
  ): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step),
      // Do not pass permission mode in report/status phases.
      permissionMode: undefined,
      sessionId,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    };
  }

  /** Build PhaseRunnerContext for Phase 2/3 execution */
  buildPhaseRunnerContext(
    state: PieceState,
    updateAgentSession: (agent: string, sessionId: string | undefined) => void,
    onPhaseStart?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void,
    onPhaseComplete?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void,
  ): PhaseRunnerContext {
    return {
      cwd: this.getCwd(),
      reportDir: join(this.getProjectCwd(), this.getReportDir()),
      language: this.getLanguage(),
      interactive: this.engineOptions.interactive,
      getSessionId: (agent: string) => state.agentSessions.get(agent),
      buildResumeOptions: this.buildResumeOptions.bind(this),
      updateAgentSession,
      onPhaseStart,
      onPhaseComplete,
    };
  }
}
