import { join } from 'node:path';
import type { PieceMovement, PieceState, Language } from '../../models/types.js';
import type { MovementProviderOptions } from '../../models/piece-types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { PhaseRunnerContext } from '../phase-runner.js';
import { resolveEffectiveProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  PieceEngineOptions,
  PhaseName,
  MovementProviderInfo,
  PhasePromptParts,
  JudgeStageEntry,
} from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { resolveMovementProviderModel } from '../provider-resolution.js';

export class OptionsBuilder {
  constructor(
    private readonly engineOptions: PieceEngineOptions,
    private readonly getCwd: () => string,
    private readonly getProjectCwd: () => string,
    private readonly getSessionId: (persona: string) => string | undefined,
    private readonly getReportDir: () => string,
    private readonly getLanguage: () => Language | undefined,
    private readonly getPieceMovements: () => ReadonlyArray<{ name: string; description?: string }>,
    private readonly getPieceName: () => string,
    private readonly getPieceDescription: () => string | undefined,
  ) {}

  resolveStepProviderModel(step: PieceMovement): MovementProviderInfo {
    const resolved = resolveMovementProviderModel({
      step,
      provider: this.engineOptions.provider,
      model: this.engineOptions.model,
      personaProviders: this.engineOptions.personaProviders,
    });
    return {
      provider: resolved.provider ?? this.engineOptions.provider,
      model: resolved.model ?? this.engineOptions.model,
    };
  }

  /** Build common RunAgentOptions shared by all phases */
  buildBaseOptions(step: PieceMovement, mergedProviderOptions?: MovementProviderOptions): RunAgentOptions {
    const movements = this.getPieceMovements();
    const currentIndex = movements.findIndex((m) => m.name === step.name);
    const currentPosition = currentIndex >= 0 ? `${currentIndex + 1}/${movements.length}` : '?/?';
    const { provider: resolvedProvider, model: resolvedModel } = this.resolveStepProviderModel(step);

    return {
      cwd: this.getCwd(),
      abortSignal: this.engineOptions.abortSignal,
      personaPath: step.personaPath,
      resolvedProvider,
      resolvedModel,
      permissionResolution: {
        movementName: step.name,
        requiredPermissionMode: step.requiredPermissionMode,
        providerProfiles: this.engineOptions.providerProfiles,
      },
      providerOptions: mergedProviderOptions ?? resolveEffectiveProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        this.engineOptions.providerOptions,
        step.providerOptions,
      ),
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
    const mergedProviderOptions = resolveEffectiveProviderOptions(
      this.engineOptions.providerOptionsSource,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptions,
      step.providerOptions,
    );

    // Phase 1: exclude Write from allowedTools when movement has output contracts AND edit is NOT enabled
    // (If edit is enabled, Write is needed for code implementation even if output contracts exist)
    // Note: edit defaults to undefined, so check !== true to catch both false and undefined
    const hasOutputContracts = step.outputContracts && step.outputContracts.length > 0;
    const resolvedAllowedTools = mergedProviderOptions?.claude?.allowedTools;
    const allowedTools = hasOutputContracts && step.edit !== true
      ? resolvedAllowedTools?.filter((t) => t !== 'Write')
      : resolvedAllowedTools;

    // Skip session resume when cwd !== projectCwd (worktree execution) to avoid cross-directory contamination
    const shouldResumeSession = step.session !== 'refresh' && this.getCwd() === this.getProjectCwd();

    return {
      ...this.buildBaseOptions(step, mergedProviderOptions),
      sessionId: shouldResumeSession ? this.getSessionId(buildSessionKey(step)) : undefined,
      allowedTools,
      mcpServers: step.mcpServers,
    };
  }

  /** Build RunAgentOptions for session-resume phases (Phase 2, Phase 3) */
  buildResumeOptions(
    step: PieceMovement,
    sessionId: string,
    overrides: Pick<RunAgentOptions, 'maxTurns'>,
  ): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step),
      // Report/status phases are read-only regardless of movement settings.
      permissionMode: 'readonly',
      sessionId,
      allowedTools: [],
      maxTurns: overrides.maxTurns,
    };
  }

  /** Build RunAgentOptions for Phase 2 retry with a new session */
  buildNewSessionReportOptions(
    step: PieceMovement,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
  ): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step),
      permissionMode: 'readonly',
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    };
  }

  /** Build PhaseRunnerContext for Phase 2/3 execution */
  buildPhaseRunnerContext(
    state: PieceState,
    lastResponse: string | undefined,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    onPhaseStart?: (
      step: PieceMovement,
      phase: 1 | 2 | 3,
      phaseName: PhaseName,
      instruction: string,
      promptParts: PhasePromptParts,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    onPhaseComplete?: (
      step: PieceMovement,
      phase: 1 | 2 | 3,
      phaseName: PhaseName,
      content: string,
      status: string,
      error?: string,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    onJudgeStage?: (
      step: PieceMovement,
      phase: 3,
      phaseName: 'judge',
      entry: JudgeStageEntry,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    iteration?: number,
  ): PhaseRunnerContext {
    return {
      cwd: this.getCwd(),
      reportDir: join(this.getCwd(), this.getReportDir()),
      language: this.getLanguage(),
      interactive: this.engineOptions.interactive,
      lastResponse,
      onStream: this.engineOptions.onStream,
      structuredCaller: this.requireStructuredCaller(),
      resolveProvider: (step) => this.resolveStepProviderModel(step).provider,
      resolveStepProviderModel: this.resolveStepProviderModel.bind(this),
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      buildResumeOptions: this.buildResumeOptions.bind(this),
      buildNewSessionReportOptions: this.buildNewSessionReportOptions.bind(this),
      updatePersonaSession,
      onPhaseStart,
      onPhaseComplete,
      onJudgeStage,
      iteration,
    };
  }

  private requireStructuredCaller(): StructuredCaller {
    if (!this.engineOptions.structuredCaller) {
      throw new Error('structuredCaller is required for phase runner context');
    }

    return this.engineOptions.structuredCaller;
  }
}
