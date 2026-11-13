import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod/v4';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import { RemoteInputManifestSchema, RemoteRunSlugSchema, type RemoteInputManifest } from '../../core/worker-pool/remoteExecutionProtocol.js';
import type { GlobalConfig, ProjectConfig } from '../../core/models/config-types.js';
import { loadGlobalConfig, loadWorkflowByIdentifier, resolveWorkflowConfigValue, getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/index.js';
import { loadGlobalConfigTraceState } from '../../infra/config/global/globalConfigCore.js';
import { loadProjectConfig, loadProjectConfigTraceState } from '../../infra/config/project/projectConfig.js';
import { getGlobalTracedSchema, getProjectTracedSchema, type TracedOrigin } from '../../infra/config/traced/tracedConfigSchema.js';
import type { ConfigTrace } from '../../infra/config/traced/tracedConfigLoader.js';
import { withConfigSnapshot } from '../../infra/config/configSnapshot.js';
import { resolveInvocationRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/invocation.js';
import type { ResolvedRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/loader.js';
import { TaskExecutionConfigSchema, TaskExecutionConfigObjectSchema } from '../../infra/task/taskExecutionSchemas.js';
import type { TaskRecord } from '../../infra/task/schema.js';
import { resolveTaskContent } from '../../infra/task/mapper.js';
import { remoteExecutionDirectory } from '../../infra/task/remoteExecutionStore.js';
import { prepareWorkflowExecutionBundle, publishWorkflowExecutionBundle, loadWorkflowExecutionBundle } from '../tasks/execute/workflowExecutionBundle.js';
import { createWorkflowCallResolver, createWorkflowExecutionContext } from '../tasks/execute/workflowExecutionContext.js';
import { resolveTaskSpecForExecution, stageTaskSpecForExecution } from '../tasks/execute/taskSpecContext.js';
import { portableRemoteConfiguration } from './remoteMcpConfiguration.js';
import { captureRemoteOpenCodeEnvironment, RemoteOpenCodeEnvironmentSchema } from './remoteExecutionEnvironment.js';

const origin = z.enum(['default', 'cli', 'env', 'local', 'global']);
const traceEntry = z.object({ origin, fileValue: z.unknown().optional(), fileOrigin: z.enum(['local', 'global']).optional() }).strict();
const traceSchema = z.record(z.string(), traceEntry);
type SerializedTrace = z.infer<typeof traceSchema>;
const objectSchema = z.record(z.string(), z.unknown());
export const RemoteExecutionInputSchema = z.object({ version: z.literal(1), runSlug: RemoteRunSlugSchema,
  task: z.string().min(1), taskConfig: TaskExecutionConfigSchema, hasTaskSpec: z.boolean(),
  project: objectSchema, global: objectSchema, projectTrace: traceSchema, globalTrace: traceSchema,
  openCode: RemoteOpenCodeEnvironmentSchema,
  runtime: z.object({ runtimeFile: z.unknown().optional(), profileOrigins: z.array(z.tuple([z.string(), z.enum(['global', 'project'])])),
    assignmentOrigins: z.object({ defaults: z.string().optional(), targets: z.string().optional() }).optional() }).strict(),
}).strict();
type RemoteExecutionInput = z.infer<typeof RemoteExecutionInputSchema>;

function serializeTrace(trace: ConfigTrace, keys: readonly string[]): SerializedTrace {
  return Object.fromEntries(keys.filter((key) => !/api_key|token|password|secret/i.test(key)).map((key) => [key, {
    origin: trace.getOrigin(key), fileValue: portableRemoteConfiguration(trace.getFileValue(key), key), fileOrigin: trace.getFileOrigin(key),
  }]));
}

function deserializeTrace(entries: SerializedTrace): ConfigTrace {
  return {
    getOrigin(path): TracedOrigin { return entries[path]?.origin ?? 'default'; },
    getFileValue(path): unknown { return entries[path]?.fileValue; },
    getFileOrigin(path) { return entries[path]?.fileOrigin; },
  };
}

export function withRemoteExecutionConfig<T>(input: RemoteExecutionInput, projectDir: string, cloneDir: string, action: () => T): T {
  // Only authentication comes from the worker. Execution configuration comes from the daemon.
  const worker = loadGlobalConfig();
  const credentials = Object.fromEntries(Object.entries(worker).filter(([key]) => /(?:ApiKey|Token)$/.test(key)));
  return withConfigSnapshot({ projectDir, additionalProjectDirs: [cloneDir], project: input.project as ProjectConfig,
    global: { ...input.global, ...credentials } as GlobalConfig,
    projectTrace: deserializeTrace(input.projectTrace), globalTrace: deserializeTrace(input.globalTrace) }, action);
}

export function remoteRuntimeConfiguration(input: RemoteExecutionInput): ResolvedRuntimeProviderFileWithOrigins {
  return { runtimeFile: input.runtime.runtimeFile as ResolvedRuntimeProviderFileWithOrigins['runtimeFile'],
    profileOrigins: new Map(input.runtime.profileOrigins), assignmentOrigins: input.runtime.assignmentOrigins };
}

export function prepareRemoteExecutionInput(cwd: string, task: TaskRecord, executionId: string): void {
  const root = join(remoteExecutionDirectory(cwd, executionId), 'input');
  const runSlug = `remote-${executionId}`;
  const paths = buildRunPaths(root, runSlug);
  const project = loadProjectConfig(cwd);
  const global = loadGlobalConfig();
  const config = { projectDir: cwd, project, global,
    projectTrace: loadProjectConfigTraceState(cwd), globalTrace: loadGlobalConfigTraceState() };
  const runtime = resolveInvocationRuntimeProviderFileWithOrigins({ globalConfigDir: getGlobalConfigDir(), projectConfigDir: getProjectConfigDir(cwd) });
  const portable = {
    project: portableRemoteConfiguration(project), global: portableRemoteConfiguration(global),
    projectTrace: serializeTrace(config.projectTrace, Object.keys(getProjectTracedSchema())),
    globalTrace: serializeTrace(config.globalTrace, Object.keys(getGlobalTracedSchema())),
    runtime: { runtimeFile: portableRemoteConfiguration(runtime.runtimeFile), profileOrigins: [...runtime.profileOrigins], assignmentOrigins: runtime.assignmentOrigins },
  };
  const taskConfig = TaskExecutionConfigSchema.parse(Object.fromEntries(Object.entries(task)
    .filter(([key]) => Object.hasOwn(TaskExecutionConfigObjectSchema.shape, key))));
  const workflow = task.workflow === undefined ? undefined : loadWorkflowByIdentifier(task.workflow, cwd, { lookupCwd: cwd });
  if (workflow === undefined || workflow === null) throw new Error('Remote task workflow is missing');
  withConfigSnapshot(config, () => {
    const policy = resolveWorkflowConfigValue(cwd, 'workflowSystemCommands');
    const resolver = createWorkflowCallResolver(createWorkflowExecutionContext(workflow, cwd, undefined, policy));
    const prepared = prepareWorkflowExecutionBundle({ rootWorkflow: workflow, workflowCallResolver: resolver,
      projectCwd: cwd, lookupCwd: cwd, centralExecution: true });
    publishWorkflowExecutionBundle(paths, prepared);
    loadWorkflowExecutionBundle(paths);
  });
  let prompt = resolveTaskContent(cwd, task);
  if (task.task_dir !== undefined) {
    const spec = resolveTaskSpecForExecution(cwd, root, task.task_dir, runSlug);
    stageTaskSpecForExecution(spec, paths);
    prompt = spec.taskPrompt;
  }
  const input = RemoteExecutionInputSchema.parse({ version: 1, runSlug, task: prompt, taskConfig,
    hasTaskSpec: task.task_dir !== undefined,
    openCode: captureRemoteOpenCodeEnvironment(process.env),
    ...portable });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'execution.json'), JSON.stringify(input), { mode: 0o600 });
  const files: RemoteInputManifest['files'] = [];
  const directories: string[] = [];
  const visit = (relative: string): void => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      if (relative !== '') directories.push(relative);
      for (const name of readdirSync(path).sort()) visit(relative === '' ? name : `${relative}/${name}`);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Remote execution input must contain only regular files');
      files.push({ path: relative, size: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  };
  visit('');
  const manifest = RemoteInputManifestSchema.parse({ version: 1, runSlug, directories, files });
  writeFileSync(join(dirname(root), 'input-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
}
