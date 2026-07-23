import { join } from 'node:path';

export interface RunPaths {
  readonly slug: string;
  readonly runRootRel: string;
  readonly reportsRel: string;
  /** namespace（workflow_call の子）を除いた run の reports ルート。 */
  readonly reportsRootRel: string;
  readonly contextRel: string;
  readonly contextTaskRel: string;
  readonly contextTaskOrderRel: string;
  readonly contextKnowledgeRel: string;
  readonly contextPolicyRel: string;
  readonly contextPreviousResponsesRel: string;
  readonly logsRel: string;
  readonly operationsRel: string;
  readonly operationJournalRel: string;
  readonly metaRel: string;
  readonly runRootAbs: string;
  readonly reportsAbs: string;
  readonly reportsRootAbs: string;
  readonly contextAbs: string;
  readonly contextTaskAbs: string;
  readonly contextTaskOrderAbs: string;
  readonly contextKnowledgeAbs: string;
  readonly contextPolicyAbs: string;
  readonly contextPreviousResponsesAbs: string;
  readonly logsAbs: string;
  readonly operationsAbs: string;
  readonly operationJournalAbs: string;
  readonly metaAbs: string;
}

function joinRel(base: string, namespace: string[] | undefined): string {
  return namespace && namespace.length > 0
    ? join(base, ...namespace)
    : base;
}

export function buildRunPaths(cwd: string, slug: string, namespace?: string[]): RunPaths {
  const runRootRel = `.takt/runs/${slug}`;
  const reportsRootRel = `${runRootRel}/reports`;
  const reportsRel = joinRel(reportsRootRel, namespace);
  const contextRel = joinRel(`${runRootRel}/context`, namespace);
  const contextTaskRel = join(contextRel, 'task');
  const contextTaskOrderRel = join(contextTaskRel, 'order.md');
  const contextKnowledgeRel = join(contextRel, 'knowledge');
  const contextPolicyRel = join(contextRel, 'policy');
  const contextPreviousResponsesRel = join(contextRel, 'previous_responses');
  const logsRel = `${runRootRel}/logs`;
  const operationsRel = `${runRootRel}/operations`;
  const operationJournalRel = `${operationsRel}/journal.json`;
  const metaRel = `${runRootRel}/meta.json`;

  return {
    slug,
    runRootRel,
    reportsRel,
    reportsRootRel,
    contextRel,
    contextTaskRel,
    contextTaskOrderRel,
    contextKnowledgeRel,
    contextPolicyRel,
    contextPreviousResponsesRel,
    logsRel,
    operationsRel,
    operationJournalRel,
    metaRel,
    runRootAbs: join(cwd, runRootRel),
    reportsAbs: join(cwd, reportsRel),
    reportsRootAbs: join(cwd, reportsRootRel),
    contextAbs: join(cwd, contextRel),
    contextTaskAbs: join(cwd, contextTaskRel),
    contextTaskOrderAbs: join(cwd, contextTaskOrderRel),
    contextKnowledgeAbs: join(cwd, contextKnowledgeRel),
    contextPolicyAbs: join(cwd, contextPolicyRel),
    contextPreviousResponsesAbs: join(cwd, contextPreviousResponsesRel),
    logsAbs: join(cwd, logsRel),
    operationsAbs: join(cwd, operationsRel),
    operationJournalAbs: join(cwd, operationJournalRel),
    metaAbs: join(cwd, metaRel),
  };
}
