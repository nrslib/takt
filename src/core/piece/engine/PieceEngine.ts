/**
 * Piece execution engine.
 *
 * Orchestrates the main execution loop: movement transitions, abort handling,
 * loop detection, and iteration limits. Delegates movement execution to
 * MovementExecutor (normal movements) and ParallelRunner (parallel movements).
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync } from 'node:fs';
import type {
  PieceConfig,
  PieceState,
  PieceMovement,
  AgentResponse,
  LoopMonitorConfig,
} from '../../models/types.js';
import { COMPLETE_MOVEMENT, ABORT_MOVEMENT, ERROR_MESSAGES } from '../constants.js';
import type { PieceEngineOptions } from '../types.js';
import { determineNextMovementByRules } from './transitions.js';
import { LoopDetector } from './loop-detector.js';
import { CycleDetector } from './cycle-detector.js';
import { handleBlocked } from './blocked-handler.js';
import {
  createInitialState,
  addUserInput as addUserInputToState,
  incrementMovementIteration,
} from './state-manager.js';
import { generateReportDir, getErrorMessage, createLogger, isValidReportDirName } from '../../../shared/utils/index.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { MovementExecutor } from './MovementExecutor.js';
import { ParallelRunner } from './ParallelRunner.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';

const log = createLogger('engine');

export type {
  PieceEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  PieceEngineOptions,
} from '../types.js';
export { COMPLETE_MOVEMENT, ABORT_MOVEMENT } from '../constants.js';

/** Piece engine for orchestrating agent execution */
export class PieceEngine extends EventEmitter {
  private state: PieceState;
  private config: PieceConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: PieceEngineOptions;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;

  private readonly optionsBuilder: OptionsBuilder;
  private readonly movementExecutor: MovementExecutor;
  private readonly parallelRunner: ParallelRunner;
  private readonly arpeggioRunner: ArpeggioRunner;
  private readonly detectRuleIndex: (content: string, movementName: string) => number;
  private readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;

  constructor(config: PieceConfig, cwd: string, task: string, options: PieceEngineOptions) {
    super();
    this.assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
    this.config = config;
    this.projectCwd = options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.options = options;
    this.loopDetector = new LoopDetector(config.loopDetection);
    this.cycleDetector = new CycleDetector(config.loopMonitors ?? []);
    if (options.reportDirName !== undefined && !isValidReportDirName(options.reportDirName)) {
      throw new Error(`Invalid reportDirName: ${options.reportDirName}`);
    }
    const reportDirName = options.reportDirName ?? generateReportDir(task);
    this.runPaths = buildRunPaths(this.cwd, reportDirName);
    this.reportDir = this.runPaths.reportsRel;
    this.ensureRunDirsExist();
    this.validateConfig();
    this.state = createInitialState(config, options);
    this.detectRuleIndex = options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
    this.callAiJudge = options.callAiJudge ?? (async () => {
      throw new Error('callAiJudge is required for rule evaluation');
    });

    // Initialize composed collaborators
    this.optionsBuilder = new OptionsBuilder(
      options,
      () => this.cwd,
      () => this.projectCwd,
      (persona) => this.state.personaSessions.get(persona),
      () => this.reportDir,
      () => this.options.language,
      () => this.config.movements.map(s => ({ name: s.name, description: s.description })),
      () => this.getPieceName(),
      () => this.getPieceDescription(),
    );

    this.movementExecutor = new MovementExecutor({
      optionsBuilder: this.optionsBuilder,
      getCwd: () => this.cwd,
      getProjectCwd: () => this.projectCwd,
      getReportDir: () => this.reportDir,
      getRunPaths: () => this.runPaths,
      getLanguage: () => this.options.language,
      getInteractive: () => this.options.interactive === true,
      getPieceMovements: () => this.config.movements.map(s => ({ name: s.name, description: s.description })),
      getPieceName: () => this.getPieceName(),
      getPieceDescription: () => this.getPieceDescription(),
      getRetryNote: () => this.options.retryNote,
      detectRuleIndex: this.detectRuleIndex,
      callAiJudge: this.callAiJudge,
      onPhaseStart: (step, phase, phaseName, instruction) => {
        this.emit('phase:start', step, phase, phaseName, instruction);
      },
      onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error) => {
        this.emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
      },
    });

    this.parallelRunner = new ParallelRunner({
      optionsBuilder: this.optionsBuilder,
      movementExecutor: this.movementExecutor,
      engineOptions: this.options,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getInteractive: () => this.options.interactive === true,
      detectRuleIndex: this.detectRuleIndex,
      callAiJudge: this.callAiJudge,
      onPhaseStart: (step, phase, phaseName, instruction) => {
        this.emit('phase:start', step, phase, phaseName, instruction);
      },
      onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error) => {
        this.emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
      },
    });

    this.arpeggioRunner = new ArpeggioRunner({
      optionsBuilder: this.optionsBuilder,
      movementExecutor: this.movementExecutor,
      getCwd: () => this.cwd,
      getInteractive: () => this.options.interactive === true,
      detectRuleIndex: this.detectRuleIndex,
      callAiJudge: this.callAiJudge,
      onPhaseStart: (step, phase, phaseName, instruction) => {
        this.emit('phase:start', step, phase, phaseName, instruction);
      },
      onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error) => {
        this.emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
      },
    });

    log.debug('PieceEngine initialized', {
      piece: config.name,
      movements: config.movements.map(s => s.name),
      initialMovement: config.initialMovement,
      maxIterations: config.maxIterations,
    });
  }

  private assertTaskPrefixPair(taskPrefix: string | undefined, taskColorIndex: number | undefined): void {
    const hasTaskPrefix = taskPrefix != null;
    const hasTaskColorIndex = taskColorIndex != null;
    if (hasTaskPrefix !== hasTaskColorIndex) {
      throw new Error('taskPrefix and taskColorIndex must be provided together');
    }
  }

  /** Ensure run directories exist (in cwd, which is clone dir in worktree mode) */
  private ensureRunDirsExist(): void {
    const requiredDirs = [
      this.runPaths.runRootAbs,
      this.runPaths.reportsAbs,
      this.runPaths.contextAbs,
      this.runPaths.contextKnowledgeAbs,
      this.runPaths.contextPolicyAbs,
      this.runPaths.contextPreviousResponsesAbs,
      this.runPaths.logsAbs,
    ];
    for (const dir of requiredDirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /** Validate piece configuration at construction time */
  private validateConfig(): void {
    const initialMovement = this.config.movements.find((s) => s.name === this.config.initialMovement);
    if (!initialMovement) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_MOVEMENT(this.config.initialMovement));
    }

    // Validate startMovement option if specified
    if (this.options.startMovement) {
      const startMovement = this.config.movements.find((s) => s.name === this.options.startMovement);
      if (!startMovement) {
        throw new Error(ERROR_MESSAGES.UNKNOWN_MOVEMENT(this.options.startMovement));
      }
    }

    const movementNames = new Set(this.config.movements.map((s) => s.name));
    movementNames.add(COMPLETE_MOVEMENT);
    movementNames.add(ABORT_MOVEMENT);

    for (const movement of this.config.movements) {
      if (movement.rules) {
        for (const rule of movement.rules) {
          if (rule.next && !movementNames.has(rule.next)) {
            throw new Error(
              `Invalid rule in movement "${movement.name}": target movement "${rule.next}" does not exist`
            );
          }
        }
      }
    }

    // Validate loop_monitors
    if (this.config.loopMonitors) {
      for (const monitor of this.config.loopMonitors) {
        for (const cycleName of monitor.cycle) {
          if (!movementNames.has(cycleName)) {
            throw new Error(
              `Invalid loop_monitor: cycle references unknown movement "${cycleName}"`
            );
          }
        }
        for (const rule of monitor.judge.rules) {
          if (!movementNames.has(rule.next)) {
            throw new Error(
              `Invalid loop_monitor judge rule: target movement "${rule.next}" does not exist`
            );
          }
        }
      }
    }
  }

  /** Get current piece state */
  getState(): PieceState {
    return { ...this.state };
  }

  /** Add user input */
  addUserInput(input: string): void {
    addUserInputToState(this.state, input);
  }

  /** Update working directory */
  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /** Get project root directory (where .takt/ lives) */
  getProjectCwd(): string {
    return this.projectCwd;
  }

  /** Get piece name */
  private getPieceName(): string {
    return this.config.name;
  }

  /** Get piece description */
  private getPieceDescription(): string | undefined {
    return this.config.description;
  }

  /** Request graceful abort: interrupt running queries and stop after current movement */
  abort(): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    log.info('Abort requested');
  }

  /** Check if abort has been requested */
  isAbortRequested(): boolean {
    return this.abortRequested;
  }

  /** Get movement by name */
  private getMovement(name: string): PieceMovement {
    const movement = this.config.movements.find((s) => s.name === name);
    if (!movement) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_MOVEMENT(name));
    }
    return movement;
  }

  /** Update persona session and notify via callback if session changed */
  private updatePersonaSession(persona: string, sessionId: string | undefined): void {
    if (!sessionId) return;

    const previousSessionId = this.state.personaSessions.get(persona);
    this.state.personaSessions.set(persona, sessionId);

    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(persona, sessionId);
    }
  }

  /** Emit movement:report events collected by MovementExecutor */
  private emitCollectedReports(): void {
    for (const { step, filePath, fileName } of this.movementExecutor.drainReportFiles()) {
      this.emit('movement:report', step, filePath, fileName);
    }
  }

  /** Run a single movement (delegates to ParallelRunner, ArpeggioRunner, or MovementExecutor) */
  private async runMovement(step: PieceMovement, prebuiltInstruction?: string): Promise<{ response: AgentResponse; instruction: string }> {
    const updateSession = this.updatePersonaSession.bind(this);
    let result: { response: AgentResponse; instruction: string };

    if (step.parallel && step.parallel.length > 0) {
      result = await this.parallelRunner.runParallelMovement(
        step, this.state, this.task, this.config.maxIterations, updateSession,
      );
    } else if (step.arpeggio) {
      result = await this.arpeggioRunner.runArpeggioMovement(
        step, this.state,
      );
    } else {
      result = await this.movementExecutor.runNormalMovement(
        step, this.state, this.task, this.config.maxIterations, updateSession, prebuiltInstruction,
      );
    }

    this.emitCollectedReports();
    return result;
  }

  /**
   * Determine next movement for a completed movement using rules-based routing.
   */
  private resolveNextMovement(step: PieceMovement, response: AgentResponse): string {
    if (response.matchedRuleIndex != null && step.rules) {
      const nextByRules = determineNextMovementByRules(step, response.matchedRuleIndex);
      if (nextByRules) {
        return nextByRules;
      }
    }

    throw new Error(`No matching rule found for movement "${step.name}" (status: ${response.status})`);
  }

  /** Build instruction (public, used by pieceExecution.ts for logging) */
  buildInstruction(step: PieceMovement, movementIteration: number): string {
    return this.movementExecutor.buildInstruction(
      step, movementIteration, this.state, this.task, this.config.maxIterations,
    );
  }

  /**
   * Build the default instruction template for a loop monitor judge.
   * Used when the monitor config does not specify a custom instruction_template.
   */
  private buildDefaultJudgeInstructionTemplate(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    language: string,
  ): string {
    const cycleNames = monitor.cycle.join(' → ');
    const rulesDesc = monitor.judge.rules.map((r) => `- ${r.condition} → ${r.next}`).join('\n');

    if (language === 'ja') {
      return [
        `ムーブメントのサイクル [${cycleNames}] が ${cycleCount} 回繰り返されました。`,
        '',
        'このループが健全（進捗がある）か、非生産的（同じ問題を繰り返している）かを判断してください。',
        '',
        '**判断の選択肢:**',
        rulesDesc,
        '',
        '**判断基準:**',
        '- 各サイクルで新しい問題が発見・修正されているか',
        '- 同じ指摘が繰り返されていないか',
        '- 全体的な進捗があるか',
      ].join('\n');
    }

    return [
      `The movement cycle [${cycleNames}] has repeated ${cycleCount} times.`,
      '',
      'Determine whether this loop is healthy (making progress) or unproductive (repeating the same issues).',
      '',
      '**Decision options:**',
      rulesDesc,
      '',
      '**Judgment criteria:**',
      '- Are new issues being found/fixed in each cycle?',
      '- Are the same findings being repeated?',
      '- Is there overall progress?',
    ].join('\n');
  }

  /**
   * Execute a loop monitor judge as a synthetic movement.
   * Returns the next movement name determined by the judge.
   */
  private async runLoopMonitorJudge(
    monitor: LoopMonitorConfig,
    cycleCount: number,
  ): Promise<string> {
    const language = this.options.language ?? 'en';
    const instructionTemplate = monitor.judge.instructionTemplate
      ?? this.buildDefaultJudgeInstructionTemplate(monitor, cycleCount, language);

    // Replace {cycle_count} in custom templates
    const processedTemplate = instructionTemplate.replace(/\{cycle_count\}/g, String(cycleCount));

    // Build a synthetic PieceMovement for the judge
    const judgeMovement: PieceMovement = {
      name: `_loop_judge_${monitor.cycle.join('_')}`,
      persona: monitor.judge.persona,
      personaPath: monitor.judge.personaPath,
      personaDisplayName: 'loop-judge',
      edit: false,
      instructionTemplate: processedTemplate,
      rules: monitor.judge.rules.map((r) => ({
        condition: r.condition,
        next: r.next,
      })),
      passPreviousResponse: true,
      allowedTools: ['Read', 'Glob', 'Grep'],
    };

    log.info('Running loop monitor judge', {
      cycle: monitor.cycle,
      cycleCount,
      threshold: monitor.threshold,
    });

    this.state.iteration++;
    const movementIteration = incrementMovementIteration(this.state, judgeMovement.name);
    const prebuiltInstruction = this.movementExecutor.buildInstruction(
      judgeMovement, movementIteration, this.state, this.task, this.config.maxIterations,
    );

    this.emit('movement:start', judgeMovement, this.state.iteration, prebuiltInstruction);

    const { response, instruction } = await this.movementExecutor.runNormalMovement(
      judgeMovement,
      this.state,
      this.task,
      this.config.maxIterations,
      this.updatePersonaSession.bind(this),
      prebuiltInstruction,
    );
    this.emitCollectedReports();
    this.emit('movement:complete', judgeMovement, response, instruction);

    // Resolve next movement from the judge's rules
    const nextMovement = this.resolveNextMovement(judgeMovement, response);

    log.info('Loop monitor judge decision', {
      cycle: monitor.cycle,
      nextMovement,
      matchedRuleIndex: response.matchedRuleIndex,
    });

    // Reset cycle detector to prevent re-triggering immediately
    this.cycleDetector.reset();

    return nextMovement;
  }

  /** Run the piece to completion */
  async run(): Promise<PieceState> {
    while (this.state.status === 'running') {
      if (this.abortRequested) {
        this.state.status = 'aborted';
        this.emit('piece:abort', this.state, 'Piece interrupted by user (SIGINT)');
        break;
      }

      if (this.state.iteration >= this.config.maxIterations) {
        this.emit('iteration:limit', this.state.iteration, this.config.maxIterations);

        if (this.options.onIterationLimit) {
          const additionalIterations = await this.options.onIterationLimit({
            currentIteration: this.state.iteration,
            maxIterations: this.config.maxIterations,
            currentMovement: this.state.currentMovement,
          });

          if (additionalIterations !== null && additionalIterations > 0) {
            this.config = {
              ...this.config,
              maxIterations: this.config.maxIterations + additionalIterations,
            };
            continue;
          }
        }

        this.state.status = 'aborted';
        this.emit('piece:abort', this.state, ERROR_MESSAGES.MAX_ITERATIONS_REACHED);
        break;
      }

      const movement = this.getMovement(this.state.currentMovement);
      const loopCheck = this.loopDetector.check(movement.name);

      if (loopCheck.shouldWarn) {
        this.emit('movement:loop_detected', movement, loopCheck.count);
      }

      if (loopCheck.shouldAbort) {
        this.state.status = 'aborted';
        this.emit('piece:abort', this.state, ERROR_MESSAGES.LOOP_DETECTED(movement.name, loopCheck.count));
        break;
      }

      this.state.iteration++;

      // Build instruction before emitting movement:start so listeners can log it.
      // Parallel and arpeggio movements handle iteration incrementing internally.
      const isDelegated = (movement.parallel && movement.parallel.length > 0) || !!movement.arpeggio;
      let prebuiltInstruction: string | undefined;
      if (!isDelegated) {
        const movementIteration = incrementMovementIteration(this.state, movement.name);
        prebuiltInstruction = this.movementExecutor.buildInstruction(
          movement, movementIteration, this.state, this.task, this.config.maxIterations,
        );
      }
      this.emit('movement:start', movement, this.state.iteration, prebuiltInstruction ?? '');

      try {
        const { response, instruction } = await this.runMovement(movement, prebuiltInstruction);
        this.emit('movement:complete', movement, response, instruction);

        if (response.status === 'blocked') {
          this.emit('movement:blocked', movement, response);
          const result = await handleBlocked(movement, response, this.options);

          if (result.shouldContinue && result.userInput) {
            this.addUserInput(result.userInput);
            this.emit('movement:user_input', movement, result.userInput);
            continue;
          }

          this.state.status = 'aborted';
          this.emit('piece:abort', this.state, 'Piece blocked and no user input provided');
          break;
        }

        if (response.status === 'error') {
          const detail = response.error ?? response.content ?? `Movement "${movement.name}" returned error status`;
          this.state.status = 'aborted';
          this.emit('piece:abort', this.state, `Movement "${movement.name}" failed: ${detail}`);
          break;
        }

        let nextMovement = this.resolveNextMovement(movement, response);
        log.debug('Movement transition', {
          from: movement.name,
          status: response.status,
          matchedRuleIndex: response.matchedRuleIndex,
          nextMovement,
        });

        if (response.matchedRuleIndex != null && movement.rules) {
          const matchedRule = movement.rules[response.matchedRuleIndex];
          if (matchedRule?.requiresUserInput) {
            if (!this.options.onUserInput) {
              this.state.status = 'aborted';
              this.emit('piece:abort', this.state, 'User input required but no handler is configured');
              break;
            }
            const userInput = await this.options.onUserInput({
              movement,
              response,
              prompt: response.content,
            });
            if (userInput === null) {
              this.state.status = 'aborted';
              this.emit('piece:abort', this.state, 'User input cancelled');
              break;
            }
            this.addUserInput(userInput);
            this.emit('movement:user_input', movement, userInput);
            this.state.currentMovement = movement.name;
            continue;
          }
        }

        // Check loop monitors (cycle detection) after movement completion
        const cycleCheck = this.cycleDetector.recordAndCheck(movement.name);
        if (cycleCheck.triggered && cycleCheck.monitor) {
          log.info('Loop monitor cycle threshold reached', {
            cycle: cycleCheck.monitor.cycle,
            cycleCount: cycleCheck.cycleCount,
            threshold: cycleCheck.monitor.threshold,
          });
          this.emit('movement:cycle_detected', cycleCheck.monitor, cycleCheck.cycleCount);

          // Run the judge to decide what to do
          nextMovement = await this.runLoopMonitorJudge(
            cycleCheck.monitor,
            cycleCheck.cycleCount,
          );
        }

        if (nextMovement === COMPLETE_MOVEMENT) {
          this.state.status = 'completed';
          this.emit('piece:complete', this.state);
          break;
        }

        if (nextMovement === ABORT_MOVEMENT) {
          this.state.status = 'aborted';
          this.emit('piece:abort', this.state, 'Piece aborted by movement transition');
          break;
        }

        this.state.currentMovement = nextMovement;
      } catch (error) {
        this.state.status = 'aborted';
        if (this.abortRequested) {
          this.emit('piece:abort', this.state, 'Piece interrupted by user (SIGINT)');
        } else {
          const message = getErrorMessage(error);
          this.emit('piece:abort', this.state, ERROR_MESSAGES.MOVEMENT_EXECUTION_FAILED(message));
        }
        break;
      }
    }

    return this.state;
  }

  /** Run a single iteration (for interactive mode) */
  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextMovement: string;
    isComplete: boolean;
    loopDetected?: boolean;
  }> {
    const movement = this.getMovement(this.state.currentMovement);
    const loopCheck = this.loopDetector.check(movement.name);

    if (loopCheck.shouldAbort) {
      this.state.status = 'aborted';
      return {
        response: {
          persona: movement.persona ?? movement.name,
          status: 'blocked',
          content: ERROR_MESSAGES.LOOP_DETECTED(movement.name, loopCheck.count),
          timestamp: new Date(),
        },
        nextMovement: ABORT_MOVEMENT,
        isComplete: true,
        loopDetected: true,
      };
    }

    this.state.iteration++;
    const { response } = await this.runMovement(movement);
    const nextMovement = this.resolveNextMovement(movement, response);
    const isComplete = nextMovement === COMPLETE_MOVEMENT || nextMovement === ABORT_MOVEMENT;

    if (response.matchedRuleIndex != null && movement.rules) {
      const matchedRule = movement.rules[response.matchedRuleIndex];
      if (matchedRule?.requiresUserInput) {
        if (!this.options.onUserInput) {
          this.state.status = 'aborted';
          return { response, nextMovement: ABORT_MOVEMENT, isComplete: true, loopDetected: loopCheck.isLoop };
        }
        const userInput = await this.options.onUserInput({
          movement,
          response,
          prompt: response.content,
        });
        if (userInput === null) {
          this.state.status = 'aborted';
          return { response, nextMovement: ABORT_MOVEMENT, isComplete: true, loopDetected: loopCheck.isLoop };
        }
        this.addUserInput(userInput);
        this.emit('movement:user_input', movement, userInput);
        this.state.currentMovement = movement.name;
        return { response, nextMovement: movement.name, isComplete: false, loopDetected: loopCheck.isLoop };
      }
    }

    if (!isComplete) {
      this.state.currentMovement = nextMovement;
    } else {
      this.state.status = nextMovement === COMPLETE_MOVEMENT ? 'completed' : 'aborted';
    }

    return { response, nextMovement, isComplete, loopDetected: loopCheck.isLoop };
  }
}
