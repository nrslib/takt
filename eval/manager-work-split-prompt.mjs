import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { toJSONSchema } from 'zod/v4';
import { resolveFacetByName, resolveFacetByNameWithSource, resolveRefToContent } from '../dist/infra/config/loaders/resource-resolver.js';
import { buildGoalTurnContext } from '../dist/features/manager/turnContext.js';
import { GoalSchema } from '../dist/infra/goals/schema.js';
import * as schemas from '../dist/features/mcp/schemas.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const managerWriteSchemas = {
  takt_enqueue_goal_task: schemas.enqueueGoalTaskInputSchema,
  takt_merge_goal_task: schemas.mergeGoalTaskInputSchema,
  takt_complete_goal: schemas.completeGoalInputSchema,
  takt_check_goal_completion: schemas.goalWriteInputSchema,
  takt_ask_goal_question: schemas.askGoalQuestionInputSchema,
  takt_withdraw_goal_question: schemas.withdrawGoalQuestionInputSchema,
  takt_notify_goal: schemas.notifyGoalInputSchema,
  takt_record_goal_decision: schemas.recordGoalDecisionInputSchema,
};

const replayConstraint = {
  ja: '評価用のテキスト再生です。この再生ではツールを呼べません。「このターンで既に読んだ結果」を読み取りツールの結果として扱ってください。本番の応答（message / summary）を response に入れ、このターンで呼ぶ書き込みツールを順に、本番と同じ引数で calls に列挙した JSON だけを返してください。形は {"response":{"message":"...","summary":null},"calls":[{"tool":"takt_enqueue_goal_task","arguments":{...}}]} です。履歴にないツールの結果を作らないでください。これは再生の出力形式であり、作業への追加要件ではありません。',
  en: 'This is a text-only evaluation replay. Tools cannot be called. Treat "Results already read this turn" as reading-tool results. Put the production response (message / summary) in response, and list this turn\'s writing-tool calls in order in calls, with the same arguments as production. Return JSON only: {"response":{"message":"...","summary":null},"calls":[{"tool":"takt_enqueue_goal_task","arguments":{...}}]}. Do not invent tool results absent from the history. This is the replay output format and adds no work requirement.',
};

export function loadManagerCase(caseId, lang) {
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(caseId)) throw new Error(`Invalid case: ${caseId}`);
  if (!['ja', 'en'].includes(lang)) throw new Error(`Invalid language: ${lang}`);
  const fixture = parse(readFileSync(join(repoRoot, 'eval', 'cases', 'manager-work-split', `${caseId}.yaml`), 'utf8'))[lang];
  if (fixture?.lang !== lang) throw new Error(`Missing ${lang} case: ${caseId}`);
  return fixture;
}

export function buildManagerSystemPrompt(fixture) {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-manager-facets-'));
  const priorConfigDir = process.env.TAKT_CONFIG_DIR;
  try {
    process.env.TAKT_CONFIG_DIR = projectDir;
    const context = { projectDir, lang: fixture.lang };
    const persona = resolveFacetByName('manager', 'personas', context);
    const policy = resolveFacetByName('manager', 'policies', context);
    const knowledge = resolveFacetByName('manager', 'knowledge', context);
    const instructionSource = resolveFacetByNameWithSource('manager', 'instructions', context);
    const instruction = instructionSource === undefined ? undefined
      : resolveRefToContent('manager', { manager: instructionSource }, projectDir, 'instructions', context);
    if ([persona, policy, knowledge, instruction].some((body) => body === undefined)) {
      throw new Error('Manager facets are missing');
    }
    return [
      persona.trim(), policy.trim(), knowledge.trim(), instruction.trim(),
      `Repository: ${JSON.stringify(fixture.cwd)}`,
      `Default workflow: ${JSON.stringify(fixture.defaultWorkflow)}`,
      `Repository manager.main_merge: ${JSON.stringify(fixture.mainMerge)}`,
      ...(process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY === '1' ? [] : [`Concurrency limit: ${fixture.concurrency}`]),
    ].join('\n\n');
  } finally {
    if (priorConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = priorConfigDir;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

export default function buildManagerWorkSplitPrompt({ vars }) {
  const fixture = loadManagerCase(vars.case, vars.lang);
  const system = buildManagerSystemPrompt(fixture);
  const user = fixture.turn === 'event'
    ? buildGoalTurnContext(fixture.cwd, GoalSchema.parse(fixture.goal), fixture.event, fixture.tasks)
    : fixture.user;
  if (typeof user !== 'string' || user.length === 0) throw new Error('Missing turn input');
  const tools = Object.fromEntries(Object.entries(managerWriteSchemas).map(([name, schema]) => [name,
    toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
  ]));
  const label = fixture.lang === 'ja' ? 'このターンで既に読んだ結果' : 'Results already read this turn';
  return `SYSTEM:\n${system}\n\nTOOLS:\n${JSON.stringify(tools)}\n\nUSER:\n${user}\n\n${label}:\n${JSON.stringify(fixture.readResults)}\n\n${replayConstraint[fixture.lang]}`;
}
