import { isAbsolute, join, relative, resolve } from 'node:path';

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
  readonly workflowBundleRel: string;
  readonly workflowBundleManifestRel: string;
  readonly workflowBundleManifestHashRel: string;
  readonly workflowBundleObjectsRel: string;
  readonly workflowBundleResourcesRel: string;
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
  readonly workflowBundleAbs: string;
  readonly workflowBundleManifestAbs: string;
  readonly workflowBundleManifestHashAbs: string;
  readonly workflowBundleObjectsAbs: string;
  readonly workflowBundleResourcesAbs: string;
}

function joinRel(base: string, namespace: string[] | undefined): string {
  return namespace && namespace.length > 0
    ? join(base, ...namespace)
    : base;
}

function buildRunPathsFromRoot(
  runsDirectory: string,
  slug: string,
  namespace: string[] | undefined,
  runRootRel: string,
): RunPaths {
  const absoluteRunsDirectory = resolve(runsDirectory);
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
  const workflowBundleRel = `${runRootRel}/workflow-bundle`;
  const workflowBundleManifestRel = `${workflowBundleRel}/manifest.json`;
  const workflowBundleManifestHashRel = `${workflowBundleRel}/manifest.sha256`;
  const workflowBundleObjectsRel = `${workflowBundleRel}/objects`;
  const workflowBundleResourcesRel = `${workflowBundleRel}/resources`;

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
    workflowBundleRel,
    workflowBundleManifestRel,
    workflowBundleManifestHashRel,
    workflowBundleObjectsRel,
    workflowBundleResourcesRel,
    runRootAbs: join(absoluteRunsDirectory, slug),
    reportsAbs: join(absoluteRunsDirectory, slug, 'reports', ...(namespace ?? [])),
    reportsRootAbs: join(absoluteRunsDirectory, slug, 'reports'),
    contextAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? [])),
    contextTaskAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? []), 'task'),
    contextTaskOrderAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? []), 'task', 'order.md'),
    contextKnowledgeAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? []), 'knowledge'),
    contextPolicyAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? []), 'policy'),
    contextPreviousResponsesAbs: join(absoluteRunsDirectory, slug, 'context', ...(namespace ?? []), 'previous_responses'),
    logsAbs: join(absoluteRunsDirectory, slug, 'logs'),
    operationsAbs: join(absoluteRunsDirectory, slug, 'operations'),
    operationJournalAbs: join(absoluteRunsDirectory, slug, 'operations', 'journal.json'),
    metaAbs: join(absoluteRunsDirectory, slug, 'meta.json'),
    workflowBundleAbs: join(absoluteRunsDirectory, slug, 'workflow-bundle'),
    workflowBundleManifestAbs: join(absoluteRunsDirectory, slug, 'workflow-bundle', 'manifest.json'),
    workflowBundleManifestHashAbs: join(absoluteRunsDirectory, slug, 'workflow-bundle', 'manifest.sha256'),
    workflowBundleObjectsAbs: join(absoluteRunsDirectory, slug, 'workflow-bundle', 'objects'),
    workflowBundleResourcesAbs: join(absoluteRunsDirectory, slug, 'workflow-bundle', 'resources'),
  };
}

export function buildRunPaths(cwd: string, slug: string, namespace?: string[]): RunPaths {
  const runRootRel = `.takt/runs/${slug}`;
  return buildRunPathsFromRoot(join(cwd, '.takt', 'runs'), slug, namespace, runRootRel);
}

/** Build absolute run paths below a state-owned runs directory. */
export function buildRunPathsFromRunsDirectory(
  runsDirectory: string,
  slug: string,
  namespace?: string[],
): RunPaths {
  if (!isAbsolute(runsDirectory)) {
    throw new Error('runsDirectory must be an absolute path');
  }
  const runRootRel = join(relative(resolve(runsDirectory, '..'), resolve(runsDirectory)), slug);
  return buildRunPathsFromRoot(runsDirectory, slug, namespace, runRootRel);
}
