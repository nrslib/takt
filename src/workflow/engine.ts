/**
 * Workflow execution engine
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
  AgentResponse,
} from '../models/types.js';
import { runAgent, type RunAgentOptions } from '../agents/runner.js';
import { COMPLETE_STEP, ABORT_STEP, ERROR_MESSAGES } from './constants.js';
import type { WorkflowEngineOptions } from './types.js';
import { determineNextStep } from './transitions.js';
import { buildInstruction as buildInstructionFromTemplate } from './instruction-builder.js';
import { LoopDetector } from './loop-detector.js';
import { handleBlocked } from './blocked-handler.js';
import {
  createInitialState,
  addUserInput,
  getPreviousOutput,
} from './state-manager.js';
import { generateReportDir } from '../utils/session.js';

// Re-export types for backward compatibility
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
} from './types.js';
export { COMPLETE_STEP, ABORT_STEP } from './constants.js';

/** Workflow engine for orchestrating agent execution */
export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private originalCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions;
  private loopDetector: LoopDetector;
  private reportDir: string;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions = {}) {
    super();
    this.config = config;
    this.originalCwd = cwd;
    this.cwd = cwd;
    this.task = task;
    this.options = options;
    this.loopDetector = new LoopDetector(config.loopDetection);
    this.reportDir = generateReportDir(task);
    this.ensureReportDirExists();
    this.validateConfig();
    this.state = createInitialState(config, options);
  }

  /** Ensure report directory exists (always in original cwd) */
  private ensureReportDirExists(): void {
    const reportDirPath = join(this.originalCwd, '.takt', 'reports', this.reportDir);
    if (!existsSync(reportDirPath)) {
      mkdirSync(reportDirPath, { recursive: true });
    }
  }

  /** Validate workflow configuration at construction time */
  private validateConfig(): void {
    const initialStep = this.config.steps.find((s) => s.name === this.config.initialStep);
    if (!initialStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(this.config.initialStep));
    }

    const stepNames = new Set(this.config.steps.map((s) => s.name));
    stepNames.add(COMPLETE_STEP);
    stepNames.add(ABORT_STEP);

    for (const step of this.config.steps) {
      for (const transition of step.transitions) {
        if (!stepNames.has(transition.nextStep)) {
          throw new Error(
            `Invalid transition in step "${step.name}": target step "${transition.nextStep}" does not exist`
          );
        }
      }
    }
  }

  /** Get current workflow state */
  getState(): WorkflowState {
    return { ...this.state };
  }

  /** Add user input */
  addUserInput(input: string): void {
    addUserInput(this.state, input);
  }

  /** Update working directory */
  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /** Get original working directory (for .takt data) */
  getOriginalCwd(): string {
    return this.originalCwd;
  }

  /** Build instruction from template */
  private buildInstruction(step: WorkflowStep): string {
    return buildInstructionFromTemplate(step, {
      task: this.task,
      iteration: this.state.iteration,
      maxIterations: this.config.maxIterations,
      cwd: this.cwd,
      userInputs: this.state.userInputs,
      previousOutput: getPreviousOutput(this.state),
      reportDir: this.reportDir,
    });
  }

  /** Get step by name */
  private getStep(name: string): WorkflowStep {
    const step = this.config.steps.find((s) => s.name === name);
    if (!step) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(name));
    }
    return step;
  }

  /** Run a single step */
  private async runStep(step: WorkflowStep): Promise<AgentResponse> {
    const instruction = this.buildInstruction(step);
    const sessionId = this.state.agentSessions.get(step.agent);

    const agentOptions: RunAgentOptions = {
      cwd: this.cwd,
      sessionId,
      agentPath: step.agentPath,
      allowedTools: step.allowedTools,
      provider: step.provider,
      model: step.model,
      onStream: this.options.onStream,
      onPermissionRequest: this.options.onPermissionRequest,
      onAskUserQuestion: this.options.onAskUserQuestion,
      bypassPermissions: this.options.bypassPermissions,
    };

    const response = await runAgent(step.agent, instruction, agentOptions);

    if (response.sessionId) {
      const previousSessionId = this.state.agentSessions.get(step.agent);
      this.state.agentSessions.set(step.agent, response.sessionId);

      if (this.options.onSessionUpdate && response.sessionId !== previousSessionId) {
        this.options.onSessionUpdate(step.agent, response.sessionId);
      }
    }

    this.state.stepOutputs.set(step.name, response);
    return response;
  }

  /** Run the workflow to completion */
  async run(): Promise<WorkflowState> {
    while (this.state.status === 'running') {
      if (this.state.iteration >= this.config.maxIterations) {
        this.emit('iteration:limit', this.state.iteration, this.config.maxIterations);

        if (this.options.onIterationLimit) {
          const additionalIterations = await this.options.onIterationLimit({
            currentIteration: this.state.iteration,
            maxIterations: this.config.maxIterations,
            currentStep: this.state.currentStep,
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
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.MAX_ITERATIONS_REACHED);
        break;
      }

      const step = this.getStep(this.state.currentStep);
      const loopCheck = this.loopDetector.check(step.name);

      if (loopCheck.shouldWarn) {
        this.emit('step:loop_detected', step, loopCheck.count);
      }

      if (loopCheck.shouldAbort) {
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
        break;
      }

      this.state.iteration++;
      this.emit('step:start', step, this.state.iteration);

      try {
        const response = await this.runStep(step);
        this.emit('step:complete', step, response);

        if (response.status === 'blocked') {
          this.emit('step:blocked', step, response);
          const result = await handleBlocked(step, response, this.options);

          if (result.shouldContinue && result.userInput) {
            this.addUserInput(result.userInput);
            this.emit('step:user_input', step, result.userInput);
            continue;
          }

          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow blocked and no user input provided');
          break;
        }

        const nextStep = determineNextStep(step, response.status, this.config);

        if (nextStep === COMPLETE_STEP) {
          this.state.status = 'completed';
          this.emit('workflow:complete', this.state);
          break;
        }

        if (nextStep === ABORT_STEP) {
          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow aborted by step transition');
          break;
        }

        this.state.currentStep = nextStep;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.STEP_EXECUTION_FAILED(message));
        break;
      }
    }

    return this.state;
  }

  /** Run a single iteration (for interactive mode) */
  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    loopDetected?: boolean;
  }> {
    const step = this.getStep(this.state.currentStep);
    const loopCheck = this.loopDetector.check(step.name);

    if (loopCheck.shouldAbort) {
      this.state.status = 'aborted';
      return {
        response: {
          agent: step.agent,
          status: 'blocked',
          content: ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count),
          timestamp: new Date(),
        },
        nextStep: ABORT_STEP,
        isComplete: true,
        loopDetected: true,
      };
    }

    this.state.iteration++;
    const response = await this.runStep(step);
    const nextStep = determineNextStep(step, response.status, this.config);
    const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

    if (!isComplete) {
      this.state.currentStep = nextStep;
    } else {
      this.state.status = nextStep === COMPLETE_STEP ? 'completed' : 'aborted';
    }

    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
  }
}

/** Create and run a workflow */
export async function executeWorkflow(
  config: WorkflowConfig,
  cwd: string,
  task: string
): Promise<WorkflowState> {
  const engine = new WorkflowEngine(config, cwd, task);
  return engine.run();
}
