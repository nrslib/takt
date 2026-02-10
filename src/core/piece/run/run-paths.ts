import { join } from 'node:path';

export interface RunPaths {
  readonly slug: string;
  readonly runRootRel: string;
  readonly reportsRel: string;
  readonly contextRel: string;
  readonly contextKnowledgeRel: string;
  readonly contextPolicyRel: string;
  readonly contextPreviousResponsesRel: string;
  readonly logsRel: string;
  readonly metaRel: string;
  readonly runRootAbs: string;
  readonly reportsAbs: string;
  readonly contextAbs: string;
  readonly contextKnowledgeAbs: string;
  readonly contextPolicyAbs: string;
  readonly contextPreviousResponsesAbs: string;
  readonly logsAbs: string;
  readonly metaAbs: string;
}

export function buildRunPaths(cwd: string, slug: string): RunPaths {
  const runRootRel = `.takt/runs/${slug}`;
  const reportsRel = `${runRootRel}/reports`;
  const contextRel = `${runRootRel}/context`;
  const contextKnowledgeRel = `${contextRel}/knowledge`;
  const contextPolicyRel = `${contextRel}/policy`;
  const contextPreviousResponsesRel = `${contextRel}/previous_responses`;
  const logsRel = `${runRootRel}/logs`;
  const metaRel = `${runRootRel}/meta.json`;

  return {
    slug,
    runRootRel,
    reportsRel,
    contextRel,
    contextKnowledgeRel,
    contextPolicyRel,
    contextPreviousResponsesRel,
    logsRel,
    metaRel,
    runRootAbs: join(cwd, runRootRel),
    reportsAbs: join(cwd, reportsRel),
    contextAbs: join(cwd, contextRel),
    contextKnowledgeAbs: join(cwd, contextKnowledgeRel),
    contextPolicyAbs: join(cwd, contextPolicyRel),
    contextPreviousResponsesAbs: join(cwd, contextPreviousResponsesRel),
    logsAbs: join(cwd, logsRel),
    metaAbs: join(cwd, metaRel),
  };
}
