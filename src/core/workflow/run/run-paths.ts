import { join } from 'node:path';

export interface RunPaths {
  readonly slug: string;
  readonly runRootRel: string;
  readonly reportsRel: string;
  readonly contextRel: string;
  readonly contextTaskRel: string;
  readonly contextTaskOrderRel: string;
  readonly contextKnowledgeRel: string;
  readonly contextPolicyRel: string;
  readonly contextPreviousResponsesRel: string;
  readonly logsRel: string;
  readonly metaRel: string;
  readonly runRootAbs: string;
  readonly reportsAbs: string;
  readonly contextAbs: string;
  readonly contextTaskAbs: string;
  readonly contextTaskOrderAbs: string;
  readonly contextKnowledgeAbs: string;
  readonly contextPolicyAbs: string;
  readonly contextPreviousResponsesAbs: string;
  readonly logsAbs: string;
  readonly metaAbs: string;
}

function joinRel(base: string, namespace: string[] | undefined): string {
  return namespace && namespace.length > 0
    ? join(base, ...namespace)
    : base;
}

export function buildRunPaths(cwd: string, slug: string, namespace?: string[]): RunPaths {
  const runRootRel = `.takt/runs/${slug}`;
  const reportsRel = joinRel(`${runRootRel}/reports`, namespace);
  const contextRel = joinRel(`${runRootRel}/context`, namespace);
  const contextTaskRel = join(contextRel, 'task');
  const contextTaskOrderRel = join(contextTaskRel, 'order.md');
  const contextKnowledgeRel = join(contextRel, 'knowledge');
  const contextPolicyRel = join(contextRel, 'policy');
  const contextPreviousResponsesRel = join(contextRel, 'previous_responses');
  const logsRel = `${runRootRel}/logs`;
  const metaRel = `${runRootRel}/meta.json`;

  return {
    slug,
    runRootRel,
    reportsRel,
    contextRel,
    contextTaskRel,
    contextTaskOrderRel,
    contextKnowledgeRel,
    contextPolicyRel,
    contextPreviousResponsesRel,
    logsRel,
    metaRel,
    runRootAbs: join(cwd, runRootRel),
    reportsAbs: join(cwd, reportsRel),
    contextAbs: join(cwd, contextRel),
    contextTaskAbs: join(cwd, contextTaskRel),
    contextTaskOrderAbs: join(cwd, contextTaskOrderRel),
    contextKnowledgeAbs: join(cwd, contextKnowledgeRel),
    contextPolicyAbs: join(cwd, contextPolicyRel),
    contextPreviousResponsesAbs: join(cwd, contextPreviousResponsesRel),
    logsAbs: join(cwd, logsRel),
    metaAbs: join(cwd, metaRel),
  };
}
