import type { PieceRule, PartDefinition } from '../../core/models/types.js';
import {
  buildPromptBasedDecomposePrompt,
  buildPromptBasedMorePartsPrompt,
  toMorePartsResponse,
} from '../team-leader-structured-output.js';
import { buildJudgePrompt, detectJudgeIndex, isValidRuleIndex, buildJudgeConditions } from '../judge-utils.js';
import { runAgent } from '../runner.js';
import {
  runTagJudgeStage,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type JudgeStatusResult,
} from '../judge-status-usecase.js';
import type { DecomposeTaskOptions, MorePartsResponse } from '../decompose-task-usecase.js';
import { TEAM_LEADER_MAX_TURNS } from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';
import {
  buildPromptBasedStructuredInstruction,
  getErrorDetail,
  parseLastJsonBlock,
  resolveStructuredStep,
} from './shared.js';
import { parseParts } from '../../core/piece/engine/task-decomposer.js';

export class PromptBasedStructuredCaller implements StructuredCaller {
  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    rules: PieceRule[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    if (rules.length === 0) {
      throw new Error('judgeStatus requires at least one rule');
    }
    if (rules.length === 1) {
      return { ruleIndex: 0, method: 'auto_select' };
    }

    const interactiveEnabled = options.interactive === true;

    const structuredResponse = await runAgent('conductor', buildPromptBasedStructuredInstruction(structuredInstruction), {
      cwd: options.cwd,
      provider: options.provider,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      maxTurns: 3,
      permissionMode: 'readonly',
      language: options.language,
      onStream: options.onStream,
      onPromptResolved: options.onStructuredPromptResolved,
    });

    options.onJudgeStage?.({
      stage: 1,
      method: 'structured_output',
      status: structuredResponse.status === 'done' ? 'done' : 'error',
      instruction: structuredInstruction,
      response: structuredResponse.content,
    });

    let structuredParseError: string | undefined;
    if (structuredResponse.status === 'done') {
      try {
        const ruleIndex = resolveStructuredStep(parseLastJsonBlock(structuredResponse.content));
        if (isValidRuleIndex(ruleIndex, rules, interactiveEnabled)) {
          return { ruleIndex, method: 'structured_output' };
        }
      } catch (error) {
        structuredParseError = getErrorDetail(error);
      }
    }

    const tagResult = await runTagJudgeStage(
      tagInstruction,
      rules,
      interactiveEnabled,
      {
        cwd: options.cwd,
        provider: options.provider,
        resolvedProvider: options.resolvedProvider,
        resolvedModel: options.resolvedModel,
        language: options.language,
        onStream: options.onStream,
        movementName: options.movementName,
      },
      options.onJudgeStage,
    );
    if (tagResult !== undefined) {
      return tagResult;
    }

    const conditions = buildJudgeConditions(rules, interactiveEnabled);

    if (conditions.length > 0) {
      let stage3Status: 'done' | 'error' | 'skipped' = 'skipped';
      let stage3Instruction = '';
      let stage3Response = '';
      const fallbackIndex = await this.evaluateCondition(structuredInstruction, conditions, {
        cwd: options.cwd,
        provider: options.provider,
        resolvedProvider: options.resolvedProvider,
        resolvedModel: options.resolvedModel,
        onJudgeResponse: (entry) => {
          stage3Status = entry.status;
          stage3Instruction = entry.instruction;
          stage3Response = entry.response;
        },
      });

      options.onJudgeStage?.({
        stage: 3,
        method: 'ai_judge',
        status: stage3Status,
        instruction: stage3Instruction,
        response: stage3Response,
      });

      if (isValidRuleIndex(fallbackIndex, rules, interactiveEnabled)) {
        return { ruleIndex: fallbackIndex, method: 'ai_judge' };
      }
    }

    const detail = structuredParseError == null
      ? ''
      : ` Structured response parsing failed: ${structuredParseError}`;
    throw new Error(`Status not found for movement "${options.movementName}".${detail}`);
  }

  async evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
    const prompt = buildJudgePrompt(agentOutput, conditions);
    const response = await runAgent(undefined, prompt, {
      cwd: options.cwd,
      provider: options.provider,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      maxTurns: 1,
      permissionMode: 'readonly',
    });

    options.onJudgeResponse?.({
      instruction: prompt,
      status: response.status === 'done' ? 'done' : 'error',
      response: response.content,
    });

    if (response.status !== 'done') {
      return -1;
    }

    return detectJudgeIndex(response.content);
  }

  async decomposeTask(
    instruction: string,
    maxParts: number,
    options: DecomposeTaskOptions,
  ): Promise<PartDefinition[]> {
    const prompt = buildPromptBasedDecomposePrompt(instruction, maxParts, options.language);
    const response = await runAgent(options.persona, prompt, {
      cwd: options.cwd,
      personaPath: options.personaPath,
      language: options.language,
      model: options.model,
      provider: options.provider,
      allowedTools: [],
      permissionMode: 'readonly',
      maxTurns: TEAM_LEADER_MAX_TURNS,
      onStream: options.onStream,
      onPromptResolved: options.onPromptResolved,
    });

    if (response.status !== 'done') {
      const detail = response.error || response.content || response.status;
      throw new Error(`Team leader failed: ${detail}`);
    }

    return parseParts(response.content, maxParts);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<MorePartsResponse> {
    const prompt = buildPromptBasedMorePartsPrompt(
      originalInstruction,
      allResults,
      existingIds,
      maxAdditionalParts,
      options.language,
    );
    const response = await runAgent(options.persona, prompt, {
      cwd: options.cwd,
      personaPath: options.personaPath,
      language: options.language,
      model: options.model,
      provider: options.provider,
      allowedTools: [],
      permissionMode: 'readonly',
      maxTurns: TEAM_LEADER_MAX_TURNS,
      onStream: options.onStream,
    });

    if (response.status !== 'done') {
      const detail = response.error || response.content || response.status;
      throw new Error(`Team leader feedback failed: ${detail}`);
    }

    return toMorePartsResponse(parseLastJsonBlock(response.content), maxAdditionalParts);
  }
}
