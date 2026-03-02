import { join } from 'node:path';
import type { PieceMovement, PieceState, Language } from '../../models/types.js';
import type { MovementProviderOptions } from '../../models/piece-types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { PhaseRunnerContext } from '../phase-runner.js';
import type { PieceEngineOptions, PhaseName, MovementProviderInfo } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { resolveMovementProviderModel } from '../provider-resolution.js';
import type { MovementProviderModelInput } from '../provider-resolution.js';
import { DEFAULT_PROVIDER_PERMISSION_PROFILES, resolveMovementPermissionMode } from '../permission-profile-resolution.js';
import { mergeProviderOptions } from '../../../infra/config/loaders/pieceParser.js';

function resolveMovementProviderOptions(
  source: 'env' | 'project' | 'global' | 'default' | undefined,
  resolvedConfigOptions: MovementProviderOptions | undefined,
  movementOptions: MovementProviderOptions | undefined,
): MovementProviderOptions | undefined {
  if (source === 'env' || source === 'project') {
    return mergeProviderOptions(movementOptions, resolvedConfigOptions);
  }
  return mergeProviderOptions(resolvedConfigOptions, movementOptions);
}

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
    private readonly getPieceProvider?: () => unknown,
    private readonly getPieceModel?: () => string | undefined,
  ) {}

  /** Resolve effective provider and model for a movement (same logic as buildBaseOptions) */
  resolveStepProviderModel(step: PieceMovement): MovementProviderInfo {
    const engineProvider = this.engineOptions.provider;
    const engineModel = this.engineOptions.model;
    const pieceProvider = this.getPieceProvider?.() as MovementProviderModelInput['pieceProvider'];
    const pieceModel = this.getPieceModel?.();
    const resolved = resolveMovementProviderModel({
      step,
      provider: engineProvider, // movement fallback: CLI/piece/global/project default provider
      model: engineModel, // movement fallback: CLI/piece/global/project default model
      pieceProvider,
      pieceModel,
      personaProviders: this.engineOptions.personaProviders,
    });
    return {
      provider: resolved.provider ?? engineProvider,
      model: resolved.model ?? engineModel,
    };
  }

  /** Build common RunAgentOptions shared by all phases */
  buildBaseOptions(step: PieceMovement): RunAgentOptions {
    const movements = this.getPieceMovements();
    const currentIndex = movements.findIndex((m) => m.name === step.name);
    const currentPosition = currentIndex >= 0 ? `${currentIndex + 1}/${movements.length}` : '?/?';
    const { provider: resolvedProvider, model: resolvedModel } = this.resolveStepProviderModel(step);

    return {
      cwd: this.getCwd(),
      abortSignal: this.engineOptions.abortSignal,
      personaPath: step.personaPath,
      provider: this.engineOptions.provider,
      model: this.engineOptions.model,
      stepProvider: resolvedProvider,
      stepModel: resolvedModel,
      permissionMode: resolveMovementPermissionMode({
        movementName: step.name,
        requiredPermissionMode: step.requiredPermissionMode,
        provider: resolvedProvider,
        projectProviderProfiles: this.engineOptions.providerProfiles,
        globalProviderProfiles: DEFAULT_PROVIDER_PERMISSION_PROFILES,
      }),
      providerOptions: resolveMovementProviderOptions(
        this.engineOptions.providerOptionsSource,
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
    // Phase 1: exclude Write from allowedTools when movement has output contracts AND edit is NOT enabled
    // (If edit is enabled, Write is needed for code implementation even if output contracts exist)
    // Note: edit defaults to undefined, so check !== true to catch both false and undefined
    const hasOutputContracts = step.outputContracts && step.outputContracts.length > 0;
    const allowedTools = hasOutputContracts && step.edit !== true
      ? step.allowedTools?.filter((t) => t !== 'Write')
      : step.allowedTools;

    // Skip session resume when cwd !== projectCwd (worktree execution) to avoid cross-directory contamination
    const shouldResumeSession = step.session !== 'refresh' && this.getCwd() === this.getProjectCwd();

    return {
      ...this.buildBaseOptions(step),
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
    onPhaseStart?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void,
    onPhaseComplete?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void,
  ): PhaseRunnerContext {
    return {
      cwd: this.getCwd(),
      reportDir: join(this.getCwd(), this.getReportDir()),
      language: this.getLanguage(),
      interactive: this.engineOptions.interactive,
      lastResponse,
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      buildResumeOptions: this.buildResumeOptions.bind(this),
      buildNewSessionReportOptions: this.buildNewSessionReportOptions.bind(this),
      updatePersonaSession,
      onPhaseStart,
      onPhaseComplete,
    };
  }
}
