import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { toJSONSchema } from 'zod/v4';
import { resolveFacetByName, resolveFacetByNameWithSource, resolveRefToContent } from '../dist/infra/config/loaders/resource-resolver.js';
import { buildManagerEventPrompt, managerInboxTurnEvent } from '../dist/features/daemon/inboxEvent.js';
import { ManagerEventSchema } from '../dist/infra/goals/events.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../dist/features/interactive/taskInstructionFormat.js';
import { loadFormalSpecVerifierConstraints } from '../dist/features/interactive/formalSpecPrompts.js';
import { renderTemplate } from '../dist/shared/prompts/index.js';
import { managerStateReads } from './manager-work-split-reads.mjs';
import * as schemas from '../dist/features/mcp/schemas.js';
import { requeueGoalTaskInputSchema, retryGoalTaskInputSchema } from '../dist/features/mcp/goalTaskRetrySchemas.js';
import { removeGoalTaskInputSchema } from '../dist/features/mcp/goalTaskRemovalSchemas.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const managerWriteSchemas = {
  takt_enqueue_goal_task: schemas.enqueueGoalTaskInputSchema,
  takt_requeue_goal_task: requeueGoalTaskInputSchema,
  takt_retry_goal_task: retryGoalTaskInputSchema,
  takt_remove_goal_task: removeGoalTaskInputSchema,
  takt_merge_goal_task: schemas.mergeGoalTaskInputSchema,
  takt_complete_goal: schemas.completeGoalInputSchema,
  takt_merge_goal_pr: schemas.mergeGoalPrInputSchema,
  takt_check_goal_completion: schemas.goalWriteInputSchema,
  takt_ask_goal_question: schemas.askGoalQuestionInputSchema,
  takt_withdraw_goal_question: schemas.withdrawGoalQuestionInputSchema,
  takt_tell_run: schemas.tellGoalRunInputSchema,
  takt_notify_goal: schemas.notifyGoalInputSchema,
  takt_record_goal_work_log: schemas.recordGoalWorkLogInputSchema,
};

const replayConstraint = {
  ja: '評価用のテキスト再生です。この再生ではツールを呼べません。「このターンで既に読んだ結果」をツールの結果として扱ってください。本番の応答（message / summary）を response に入れ、このターンで呼ぶ書き込みツールを順に、本番と同じ引数で calls に列挙した JSON だけを返してください。形は {"response":{"message":"...","summary":null},"calls":[{"tool":"takt_enqueue_goal_task","arguments":{...}}]} です。履歴にないツールの結果を作らないでください。これは再生の出力形式であり、作業への追加要件ではありません。',
  en: 'This is a text-only evaluation replay. Tools cannot be called. Treat "Results already read this turn" as tool results. Put the production response (message / summary) in response, and list this turn\'s writing-tool calls in order in calls, with the same arguments as production. Return JSON only: {"response":{"message":"...","summary":null},"calls":[{"tool":"takt_enqueue_goal_task","arguments":{...}}]}. Do not invent tool results absent from the history. This is the replay output format and adds no work requirement.',
};

export function loadManagerCase(caseId, lang) {
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(caseId)) throw new Error(`Invalid case: ${caseId}`);
  if (!['ja', 'en'].includes(lang)) throw new Error(`Invalid language: ${lang}`);
  const fixture = parse(readFileSync(join(repoRoot, 'eval', 'cases', 'manager-work-split', `${caseId}.yaml`), 'utf8'))[lang];
  if (fixture?.lang !== lang) throw new Error(`Missing ${lang} case: ${caseId}`);
  let current = fixture;
  if (fixture.event?.kind === 'patrol') {
    const offset = Date.now() - Date.parse(fixture.snapshotAt);
    current = JSON.parse(JSON.stringify(fixture).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      (timestamp) => new Date(Date.parse(timestamp) + offset).toISOString()));
  }
  if (current.turn === 'event') current.readResults = managerStateReads(current);
  return current;
}

export function buildManagerSystemPrompt(fixture) {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-manager-facets-'));
  const priorConfigDir = process.env.TAKT_CONFIG_DIR;
  try {
    process.env.TAKT_CONFIG_DIR = projectDir;
    if (fixture.projectConfig !== undefined) {
      mkdirSync(join(projectDir, '.takt'));
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringify(fixture.projectConfig));
    }
    const context = { projectDir, lang: fixture.lang };
    const persona = resolveFacetByName('manager', 'personas', context);
    const policy = resolveManagerEvalFacet('policies', 'TAKT_EVAL_MANAGER_POLICY_ROOT', context, process.env.TAKT_EVAL_MANAGER_POLICY_ROOT);
    const knowledge = resolveFacetByName('manager', 'knowledge', context);
    const instruction = resolveManagerEvalFacet('instructions', 'TAKT_EVAL_MANAGER_INSTRUCTION_ROOT', context, process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT);
    if ([persona, policy, knowledge, instruction].some((body) => body === undefined)) {
      throw new Error('Manager facets are missing');
    }
    const specificationConfiguration = resolveFormalSpecConfigurationWithoutPrompt(projectDir);
    return [
      persona.trim(), policy.trim(), knowledge.trim(), renderTemplate(instruction.trim(), {
        formalSpec: specificationConfiguration.mode,
        formalSpecCommentsEnabled: specificationConfiguration.mode && specificationConfiguration.comments,
        formalSpecVerifierConstraints: loadFormalSpecVerifierConstraints(fixture.lang),
      }),
      `Formal specification configuration: ${JSON.stringify(specificationConfiguration)}`,
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

export function resolveManagerEvalFacet(facetType, envKey, context, root) {
  if (root !== undefined && !isAbsolute(root)) throw new Error(`${envKey} must be an absolute path`);
  const source = root === undefined
    ? resolveFacetByNameWithSource('manager', facetType, context)
    : {
      content: readFileSync(join(root, context.lang, 'manager.md'), 'utf8'),
      sourcePath: join(root, context.lang, 'manager.md'),
      facetType,
      refName: 'manager',
    };
  return source === undefined ? undefined
    : resolveRefToContent('manager', { manager: source }, context.projectDir, facetType, context);
}

export function buildManagerEventInput(cwd, saved) {
  const event = ['watch_observation', 'patrol'].includes(saved.kind) ? saved : managerInboxTurnEvent(cwd, ManagerEventSchema.parse(saved));
  return buildManagerEventPrompt(event);
}

export default function buildManagerWorkSplitPrompt({ vars }) {
  const fixture = loadManagerCase(vars.case, vars.lang);
  if (fixture.execution === true) return JSON.stringify({ case: vars.case, lang: fixture.lang, user: fixture.user });
  const system = buildManagerSystemPrompt(fixture);
  const user = fixture.turn === 'event'
    ? buildManagerEventInput(fixture.cwd, fixture.event)
    : fixture.user;
  if (typeof user !== 'string' || user.length === 0) throw new Error('Missing turn input');
  const tools = Object.fromEntries(Object.entries(managerWriteSchemas).map(([name, schema]) => [name,
    toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
  ]));
  const history = fixture.previousTurns === undefined ? ''
    : `PREVIOUS TURNS:\n${JSON.stringify(fixture.previousTurns.map(({ event, response }) => ({
      input: buildManagerEventInput(fixture.cwd, event), response,
    })))}\n\n`;
  const label = fixture.lang === 'ja' ? 'このターンで既に読んだ結果' : 'Results already read this turn';
  return `SYSTEM:\n${system}\n\n${history}TOOLS:\n${JSON.stringify(tools)}\n\nUSER:\n${user}\n\n${label}:\n${JSON.stringify(fixture.readResults)}\n\n${replayConstraint[fixture.lang]}`;
}
