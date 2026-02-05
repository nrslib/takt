/**
 * Fallback strategies for Phase 3 judgment.
 *
 * Implements Chain of Responsibility pattern to try multiple judgment methods
 * when conductor cannot determine the status from report alone.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PieceMovement, Language } from '../../models/types.js';
import { runAgent } from '../../../agents/runner.js';
import { StatusJudgmentBuilder } from '../instruction/StatusJudgmentBuilder.js';
import { JudgmentDetector, type JudgmentResult } from './JudgmentDetector.js';
import { hasOnlyOneBranch, getAutoSelectedTag, getReportFiles } from '../evaluation/rule-utils.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('fallback-strategy');

export interface JudgmentContext {
  step: PieceMovement;
  cwd: string;
  language?: Language;
  reportDir?: string;
  lastResponse?: string; // Phase 1の最終応答
  sessionId?: string;
}

export interface JudgmentStrategy {
  readonly name: string;
  canApply(context: JudgmentContext): boolean;
  execute(context: JudgmentContext): Promise<JudgmentResult>;
}

/**
 * Base class for judgment strategies using Template Method Pattern.
 */
abstract class JudgmentStrategyBase implements JudgmentStrategy {
  abstract readonly name: string;

  abstract canApply(context: JudgmentContext): boolean;

  async execute(context: JudgmentContext): Promise<JudgmentResult> {
    try {
      // 1. 情報収集（サブクラスで実装）
      const input = await this.gatherInput(context);

      // 2. 指示生成（サブクラスで実装）
      const instruction = this.buildInstruction(input, context);

      // 3. conductor実行（共通）
      const response = await this.runConductor(instruction, context);

      // 4. 結果検出（共通）
      return JudgmentDetector.detect(response);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.debug(`Strategy ${this.name} threw error`, { error: errorMsg });
      return {
        success: false,
        reason: `Strategy failed with error: ${errorMsg}`,
      };
    }
  }

  protected abstract gatherInput(context: JudgmentContext): Promise<string>;

  protected abstract buildInstruction(input: string, context: JudgmentContext): string;

  protected async runConductor(instruction: string, context: JudgmentContext): Promise<string> {
    const response = await runAgent('conductor', instruction, {
      cwd: context.cwd,
      allowedTools: [],
      maxTurns: 3,
      language: context.language,
    });

    if (response.status !== 'done') {
      throw new Error(`Conductor failed: ${response.error || response.content || 'Unknown error'}`);
    }

    return response.content;
  }
}

/**
 * Strategy 1: Auto-select when there's only one branch.
 * This strategy doesn't use conductor - just returns the single tag.
 */
export class AutoSelectStrategy implements JudgmentStrategy {
  readonly name = 'AutoSelect';

  canApply(context: JudgmentContext): boolean {
    return hasOnlyOneBranch(context.step);
  }

  async execute(context: JudgmentContext): Promise<JudgmentResult> {
    const tag = getAutoSelectedTag(context.step);
    log.debug('Auto-selected tag (single branch)', { tag });
    return {
      success: true,
      tag,
    };
  }
}

/**
 * Strategy 2: Report-based judgment.
 * Read report files and ask conductor to judge.
 */
export class ReportBasedStrategy extends JudgmentStrategyBase {
  readonly name = 'ReportBased';

  canApply(context: JudgmentContext): boolean {
    return context.reportDir !== undefined && getReportFiles(context.step.report).length > 0;
  }

  protected async gatherInput(context: JudgmentContext): Promise<string> {
    if (!context.reportDir) {
      throw new Error('Report directory not provided');
    }

    const reportFiles = getReportFiles(context.step.report);
    if (reportFiles.length === 0) {
      throw new Error('No report files configured');
    }

    const reportContents: string[] = [];
    for (const fileName of reportFiles) {
      const filePath = resolve(context.reportDir, fileName);
      try {
        const content = readFileSync(filePath, 'utf-8');
        reportContents.push(`# ${fileName}\n\n${content}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read report file ${fileName}: ${errorMsg}`);
      }
    }

    return reportContents.join('\n\n---\n\n');
  }

  protected buildInstruction(input: string, context: JudgmentContext): string {
    return new StatusJudgmentBuilder(context.step, {
      language: context.language,
      reportContent: input,
      inputSource: 'report',
    }).build();
  }
}

/**
 * Strategy 3: Response-based judgment.
 * Use the last response from Phase 1 to judge.
 */
export class ResponseBasedStrategy extends JudgmentStrategyBase {
  readonly name = 'ResponseBased';

  canApply(context: JudgmentContext): boolean {
    return context.lastResponse !== undefined && context.lastResponse.length > 0;
  }

  protected async gatherInput(context: JudgmentContext): Promise<string> {
    if (!context.lastResponse) {
      throw new Error('Last response not provided');
    }
    return context.lastResponse;
  }

  protected buildInstruction(input: string, context: JudgmentContext): string {
    return new StatusJudgmentBuilder(context.step, {
      language: context.language,
      lastResponse: input,
      inputSource: 'response',
    }).build();
  }
}

/**
 * Strategy 4: Agent consult.
 * Resume the Phase 1 agent session and ask which tag is appropriate.
 */
export class AgentConsultStrategy implements JudgmentStrategy {
  readonly name = 'AgentConsult';

  canApply(context: JudgmentContext): boolean {
    return context.sessionId !== undefined && context.sessionId.length > 0;
  }

  async execute(context: JudgmentContext): Promise<JudgmentResult> {
    if (!context.sessionId) {
      return {
        success: false,
        reason: 'Session ID not provided',
      };
    }

    try {
      const question = this.buildQuestion(context);

      const response = await runAgent(context.step.agent ?? context.step.name, question, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        maxTurns: 3,
        language: context.language,
      });

      if (response.status !== 'done') {
        return {
          success: false,
          reason: `Agent consultation failed: ${response.error || 'Unknown error'}`,
        };
      }

      return JudgmentDetector.detect(response.content);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.debug('Agent consult strategy failed', { error: errorMsg });
      return {
        success: false,
        reason: `Agent consultation error: ${errorMsg}`,
      };
    }
  }

  private buildQuestion(context: JudgmentContext): string {
    const rules = context.step.rules || [];
    const ruleDescriptions = rules.map((rule, idx) => {
      const tag = `[${context.step.name.toUpperCase()}:${idx + 1}]`;
      const desc = rule.condition || `Rule ${idx + 1}`;
      return `- ${tag}: ${desc}`;
    }).join('\n');

    const lang = context.language || 'en';

    if (lang === 'ja') {
      return `あなたの作業結果に基づいて、以下の判定タグのうちどれが適切か教えてください：\n\n${ruleDescriptions}\n\n該当するタグを1つだけ出力してください（例: [${context.step.name.toUpperCase()}:1]）。`;
    } else {
      return `Based on your work, which of the following judgment tags is appropriate?\n\n${ruleDescriptions}\n\nPlease output only one tag (e.g., [${context.step.name.toUpperCase()}:1]).`;
    }
  }
}

/**
 * Factory for creating judgment strategies in order of priority.
 */
export class JudgmentStrategyFactory {
  static createStrategies(): JudgmentStrategy[] {
    return [
      new AutoSelectStrategy(),
      new ReportBasedStrategy(),
      new ResponseBasedStrategy(),
      new AgentConsultStrategy(),
    ];
  }
}
