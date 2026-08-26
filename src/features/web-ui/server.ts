import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  readProjectRegistry,
  registerProject,
  resolveRegisteredProject,
  type RegisteredProject,
} from '../../infra/config/global/projectRegistry.js';
import {
  readRunCollection,
  readRunDetail,
  resolveRunWatchDirectories,
} from './run-store.js';
import { parseLaunchRequest, type LaunchRequest, type LaunchResult } from './launcher.js';
import {
  createWebChatService,
  parseCreateWebChatRequest,
  parseWebChatMessageRequest,
  WebChatInputError,
  type WebChatService,
  type WebTaskActionContext,
  type WebTaskActionClaim,
} from './chat.js';
import { readWorkflowCatalog, type WebWorkflowCatalog } from './workflow-catalog.js';
import { browseDirectory, parseDirectoryBrowseRequest } from './directory-browser.js';
import {
  NativeDirectoryPickerUnavailableError,
  pickNativeDirectoryOnHost,
  type NativeDirectoryPickerResult,
} from './native-directory-picker.js';
import { resolveStatePaths } from '../../core/execution/locations.js';
import {
  CentralTaskBusyError,
  CentralTaskCasError,
  CentralTaskRepository,
  CentralTaskRequeueError,
  type CentralTaskRecord,
  parseCentralTasks,
} from '../../infra/task/centralStateRepository.js';
import {
  CentralTaskActionError,
  getCentralTaskActions,
  parseCentralTaskAction,
  projectCentralTaskStatus,
  type CentralTaskAction,
  type CentralTaskActionResult,
} from './task-actions.js';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_GLOBAL_TASKS = 100;
const STREAM_RECONCILE_INTERVAL_MS = 2_000;
const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

interface StaticAsset {
  readonly content: Buffer;
  readonly contentType: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setSecurityHeaders(response);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

function writeSnapshotEvent(
  response: ServerResponse,
  id: number,
  serialized: string,
): void {
  response.write(`id: ${id}\nevent: snapshot\ndata: ${serialized}\n\n`);
}

async function streamSnapshots(
  response: ServerResponse,
  readSnapshot: () => Promise<unknown>,
  watchDirectories: readonly string[],
): Promise<void> {
  const initial = JSON.stringify(await readSnapshot());
  setSecurityHeaders(response);
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
  });
  let eventId = 1;
  let lastSnapshot = initial;
  let reading = false;
  let closed = false;
  writeSnapshotEvent(response, eventId, initial);

  const publish = async (): Promise<void> => {
    if (reading || closed) return;
    reading = true;
    try {
      const next = JSON.stringify(await readSnapshot());
      if (!closed && next !== lastSnapshot) {
        lastSnapshot = next;
        eventId += 1;
        writeSnapshotEvent(response, eventId, next);
      }
    } catch (error) {
      if (!closed) {
        response.write(`event: snapshot-error\ndata: ${JSON.stringify({ error: errorMessage(error) })}\n\n`);
      }
    } finally {
      reading = false;
    }
  };

  const watchers: FSWatcher[] = [];
  for (const directory of watchDirectories) {
    try {
      watchers.push(watch(directory, () => void publish()));
    } catch {
      // Periodic reconciliation below remains the source of correctness.
    }
  }
  const reconcileTimer = setInterval(() => void publish(), STREAM_RECONCILE_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed) response.write(': keep-alive\n\n');
  }, STREAM_HEARTBEAT_INTERVAL_MS);

  await new Promise<void>((resolvePromise) => {
    response.once('close', () => {
      closed = true;
      clearInterval(reconcileTimer);
      clearInterval(heartbeatTimer);
      for (const watcher of watchers) watcher.close();
      resolvePromise();
    });
  });
}

function writeChatStreamRecord(response: ServerResponse, value: unknown): void {
  if (!response.headersSent) {
    setSecurityHeaders(response);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    });
  }
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(value)}\n`);
  }
}

async function streamChatReply(
  response: ServerResponse,
  send: (onThinking: (content: string) => void) => Promise<unknown>,
): Promise<void> {
  try {
    const reply = await send((content) => {
      writeChatStreamRecord(response, { type: 'thinking', content });
    });
    writeChatStreamRecord(response, { type: 'reply', reply });
    if (!response.writableEnded && !response.destroyed) response.end();
  } catch (error) {
    if (!response.headersSent) throw error;
    writeChatStreamRecord(response, { type: 'error', message: asHttpError(error).message });
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

function sendStatic(
  response: ServerResponse,
  asset: StaticAsset,
): void {
  setSecurityHeaders(response);
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': asset.contentType,
  });
  response.end(asset.content);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, 'Request body is too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function requireSessionToken(request: IncomingMessage, sessionToken: string): void {
  const candidate = request.headers['x-takt-web-token'];
  if (
    typeof candidate !== 'string'
    || candidate.length !== sessionToken.length
    || !timingSafeEqual(Buffer.from(candidate), Buffer.from(sessionToken))
  ) {
    throw new HttpError(403, 'Session token is invalid');
  }
}

function requireControlToken(request: IncomingMessage, controlToken: string): void {
  const candidate = request.headers['x-takt-web-control-token'];
  if (
    typeof candidate !== 'string'
    || candidate.length !== controlToken.length
    || !timingSafeEqual(Buffer.from(candidate), Buffer.from(controlToken))
  ) {
    throw new HttpError(403, 'Control token is invalid');
  }
}

function requireLoopbackOrigin(request: IncomingMessage): void {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0) {
    throw new HttpError(403, 'Host header is missing');
  }
  let parsedHost: URL;
  try {
    parsedHost = new URL(`http://${host}`);
  } catch {
    throw new HttpError(403, 'Host header is invalid');
  }
  const hostname = parsedHost.hostname.toLowerCase();
  if (!new Set(['127.0.0.1', 'localhost', '[::1]', '::1']).has(hostname)) {
    throw new HttpError(403, 'Host header is not allowed');
  }
  const localPort = request.socket.localPort;
  if (localPort !== undefined && parsedHost.port !== '' && Number(parsedHost.port) !== localPort) {
    throw new HttpError(403, 'Host port is not allowed');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new HttpError(403, 'Origin is not allowed');
    }
    if (
      parsedOrigin.protocol !== 'http:'
      || parsedOrigin.hostname.toLowerCase() !== hostname
      || (localPort !== undefined && parsedOrigin.port !== '' && Number(parsedOrigin.port) !== localPort)
    ) {
      throw new HttpError(403, 'Origin is not allowed');
    }
  }
}

async function loadAssets() {
  const definitions = [
    ['/', '../../../web-ui/public/index.html', 'text/html; charset=utf-8'],
    ['/app.js', '../../../web-ui/public/app.js', 'text/javascript; charset=utf-8'],
    ['/i18n.js', '../../../web-ui/public/i18n.js', 'text/javascript; charset=utf-8'],
    ['/api.js', '../../../web-ui/public/api.js', 'text/javascript; charset=utf-8'],
    ['/execution-model.js', '../../../web-ui/public/execution-model.js', 'text/javascript; charset=utf-8'],
    ['/execution-map.js', '../../../web-ui/public/execution-map.js', 'text/javascript; charset=utf-8'],
    ['/execution-view.js', '../../../web-ui/public/execution-view.js', 'text/javascript; charset=utf-8'],
    ['/markdown-view.js', '../../../web-ui/public/markdown-view.js', 'text/javascript; charset=utf-8'],
    ['/live-stream.js', '../../../web-ui/public/live-stream.js', 'text/javascript; charset=utf-8'],
    ['/task-action-ui.js', '../../../web-ui/public/task-action-ui.js', 'text/javascript; charset=utf-8'],
    ['/task-navigator.js', '../../../web-ui/public/task-navigator.js', 'text/javascript; charset=utf-8'],
    ['/ui-state.js', '../../../web-ui/public/ui-state.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', '../../../web-ui/public/styles.css', 'text/css; charset=utf-8'],
    ['/takt-logo.svg', '../../../docs/assets/takt-logo-dark.svg', 'image/svg+xml'],
  ] as const;
  const assets = await Promise.all(definitions.map(async ([route, path, contentType]) => [
    route,
    { content: await readFile(new URL(path, import.meta.url)), contentType },
  ] as const));
  return new Map<string, StaticAsset>(assets);
}

function routeRunSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  return match?.[1] ?? null;
}

function routeRunStreamSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/events$/);
  return match?.[1] ?? null;
}

function routeTaskRequeueId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/requeue$/u);
  return match?.[1] ?? null;
}

function routeTaskAction(pathname: string): { taskId: string; action: string } | null {
  const match = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/actions\/([A-Za-z0-9_-]+)$/u);
  return match === null ? null : { taskId: match[1]!, action: match[2]! };
}

function routeChatSessionId(
  pathname: string,
  action: 'messages' | 'settings' | 'restart',
): string | null {
  const match = pathname.match(
    new RegExp(`^/api/chat/sessions/([A-Za-z0-9_-]+)/${action}$`, 'u'),
  );
  return match?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof WebChatInputError) return new HttpError(error.status, error.message);
  if (error instanceof NativeDirectoryPickerUnavailableError) {
    return new HttpError(501, error.message);
  }
  if (error instanceof CentralTaskBusyError) {
    return new HttpError(409, error.message);
  }
  if (error instanceof CentralTaskRequeueError) {
    return new HttpError(409, error.message);
  }
  if (error instanceof CentralTaskActionError) {
    return new HttpError(error.status, error.message);
  }
  if (error instanceof CentralTaskCasError) {
    return new HttpError(409, error.message);
  }
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return new HttpError(404, 'Run not found');
  }
  return new HttpError(500, errorMessage(error));
}

function parseLaunchBody(value: unknown): LaunchRequest {
  try {
    return parseLaunchRequest(value);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

function projectIdFromBody(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const projectId = (value as Readonly<Record<string, unknown>>).projectId;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new HttpError(400, 'projectId is required');
  }
  return projectId;
}

function optionalActionInput(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const input = (value as Readonly<Record<string, unknown>>).input;
  if (input === undefined) return undefined;
  if (typeof input !== 'string') throw new HttpError(400, 'input must be a string');
  return input;
}

function optionalConversationId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const conversationId = (value as Readonly<Record<string, unknown>>).conversationId;
  if (conversationId === undefined) return undefined;
  if (
    typeof conversationId !== 'string'
    || conversationId.length === 0
    || conversationId.length > 256
    || conversationId.includes('\0')
  ) {
    throw new HttpError(400, 'conversationId is invalid');
  }
  return conversationId;
}

function optionalTaskActionOptionId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const optionId = (value as Readonly<Record<string, unknown>>).taskActionOptionId;
  if (optionId === undefined) return undefined;
  if (
    typeof optionId !== 'string'
    || optionId.trim().length === 0
    || optionId.length > 256
    || optionId.includes('\0')
  ) {
    throw new HttpError(400, 'taskActionOptionId is invalid');
  }
  return optionId;
}

function projectDirectoryFromBody(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const projectDirectory = (value as Readonly<Record<string, unknown>>).projectDirectory;
  if (
    typeof projectDirectory !== 'string'
    || projectDirectory.length === 0
    || projectDirectory.includes('\0')
    || !isAbsolute(projectDirectory)
  ) {
    throw new HttpError(400, 'projectDirectory must be an absolute path');
  }
  return projectDirectory;
}

function parseBrowseBody(value: unknown): string {
  try {
    return parseDirectoryBrowseRequest(value);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

async function browseRequestedDirectory(value: unknown) {
  try {
    return await browseDirectory(parseBrowseBody(value));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, errorMessage(error));
  }
}

async function registerSelectedProject(
  globalConfigDirectory: string,
  value: unknown,
): Promise<RegisteredProject> {
  try {
    return await registerProject({
      globalConfigDirectory,
      projectDirectory: projectDirectoryFromBody(value),
      command: 'ui',
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, errorMessage(error));
  }
}

function projectIdFromQuery(url: URL): string {
  const projectId = url.searchParams.get('project');
  if (projectId === null || projectId.length === 0) {
    throw new HttpError(400, 'project query parameter is required');
  }
  return projectId;
}

async function resolveProject(globalConfigDirectory: string, id: string): Promise<RegisteredProject> {
  try {
    return await resolveRegisteredProject(globalConfigDirectory, id);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

async function verifyTaskActionAvailability(
  globalConfigDirectory: string,
  project: RegisteredProject,
  taskId: string,
  action: CentralTaskAction,
): Promise<CentralTaskRecord> {
  const repository = await CentralTaskRepository.openByState({
    globalConfigDirectory,
    stateId: project.stateId,
  });
  await repository.reconcile();
  const task = await repository.readTask(taskId);
  if (task === undefined) {
    throw new CentralTaskActionError('Central task was not found', 404);
  }
  if (!getCentralTaskActions(task).includes(action)) {
    throw new CentralTaskActionError(`Action ${action} is not available for task ${taskId}`);
  }
  return task;
}

function assertTaskActionSnapshot(
  context: WebTaskActionContext,
  project: RegisteredProject,
  task: CentralTaskRecord,
  action: CentralTaskAction,
): void {
  if (
    context.taskId !== task.taskId
    || context.action !== action
    || context.projectId !== project.id
    || context.stateId !== project.stateId
    || context.projectDirectory !== project.canonicalDirectory
    || context.generation !== task.generation
    || context.sourceRunId !== task.runId
    || context.runId !== task.runId
    || context.worktreePath !== task.worktreePath
    || context.status !== projectCentralTaskStatus(task)
    || context.runIds.length !== task.runIds.length
    || context.runIds.some((runId, index) => runId !== task.runIds[index])
  ) {
    throw new CentralTaskActionError('Task action conversation is stale', 409);
  }
}

function releaseTaskActionReservation(
  chat: WebChatService,
  conversationId: string | undefined,
  reservationToken: string,
  originalError: unknown,
): void {
  if (conversationId === undefined) return;
  try {
    chat.releaseTaskAction(conversationId, reservationToken);
  } catch (releaseError) {
    // Preserve the action error and retain the cleanup failure for diagnostics.
    if (originalError instanceof Error && originalError.cause === undefined) {
      originalError.cause = releaseError;
    }
  }
}

async function readGlobalTasks(globalConfigDirectory: string) {
  const registry = await readProjectRegistry(globalConfigDirectory);
  const results = await Promise.all(registry.projects.map(async (project) => {
    if (!project.available) {
      return { tasks: [], warnings: [`${project.projectDirectory}: project directory is unavailable`] };
    }
    try {
      const statePaths = resolveStatePaths(globalConfigDirectory, project.stateId);
      if (!existsSync(statePaths.runsDirectory) || !existsSync(statePaths.stateFile)) {
        return { tasks: [], warnings: [] };
      }
      const repository = await CentralTaskRepository.openByState({
        globalConfigDirectory,
        stateId: project.stateId,
      });
      const collection = await readRunCollection(repository.paths);
      const runsBySlug = new Map(collection.runs.map((run) => [run.slug, run]));
      const tasks = (await repository.readTasks()).map((task) => {
        const status = projectCentralTaskStatus(task);
        const actions = getCentralTaskActions(task);
        return {
          taskId: task.taskId,
          status,
          task: task.task,
          workflow: task.workflow,
          attempt: task.attempt,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          worktree: task.worktree,
          ...(task.branch === undefined ? {} : { branch: task.branch }),
          ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
          ...(task.worktreePath === undefined ? {} : { worktreePath: task.worktreePath }),
          autoPr: task.autoPr === true,
          draftPr: task.draftPr === true,
          ...(task.failure === undefined ? {} : { failure: task.failure }),
          ...(task.prUrl === undefined ? {} : { prUrl: task.prUrl }),
          actions: Object.fromEntries(actions.map((action) => [action, true])),
          actionList: actions,
          projectId: project.id,
          locationId: project.locationId,
          stateId: project.stateId,
          projectName: project.displayName,
          projectDirectory: project.projectDirectory,
          runs: task.runIds.flatMap((runId, index) => {
            const run = runsBySlug.get(runId);
            if (run === undefined) return [];
            const isLatest = index === task.runIds.length - 1;
            return [{
              ...run,
              attempt: index + 1,
              ...(isLatest ? { status } : {}),
            }];
          }),
        };
      });
      return {
        tasks,
        warnings: collection.warnings.map((warning) => `${project.displayName}: ${warning}`),
      };
    } catch (error) {
      return {
        tasks: [],
        warnings: [`${project.projectDirectory}: ${errorMessage(error)}`],
      };
    }
  }));
  return {
    tasks: results
      .flatMap((result) => result.tasks)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_GLOBAL_TASKS),
    warnings: [...registry.warnings, ...results.flatMap((result) => result.warnings)],
  };
}

async function readRunView(
  globalConfigDirectory: string,
  project: RegisteredProject,
  slug: string,
) {
  const repository = await CentralTaskRepository.openByState({
    globalConfigDirectory,
    stateId: project.stateId,
  });
  const detail = await readRunDetail(repository.paths, slug);
  const task = (await repository.readTasks()).find((candidate) => candidate.runIds.includes(slug));
  const isLatestTaskRun = task?.runIds.at(-1) === slug;
  return {
    project,
    ...detail,
    ...(task === undefined
      ? {}
      : {
          taskId: task.taskId,
          meta: {
            ...detail.meta,
            ...(isLatestTaskRun
              ? { status: projectCentralTaskStatus(task) }
              : {}),
            ...(isLatestTaskRun && task.failure !== undefined
              ? { reason: task.failure.message }
              : {}),
          },
          ...(task.prUrl === undefined ? {} : { prUrl: task.prUrl }),
        }),
  };
}

async function readProjectDiscovery(globalConfigDirectory: string) {
  const registry = await readProjectRegistry(globalConfigDirectory);
  const warnings = [...registry.warnings];
  const projects = await Promise.all(registry.projects.map(async (project) => {
    const statePaths = resolveStatePaths(globalConfigDirectory, project.stateId);
    // Discovery is read-only: do not create a central state namespace merely
    // to report that no UI task has ever run for this project.
    if (!existsSync(statePaths.tasksFile)) return project;
    try {
      const tasks = parseCentralTasks(JSON.parse(await readFile(statePaths.tasksFile, 'utf8')) as unknown);
      const active = tasks.find((task) => (
        task.activeExecution !== undefined || task.drainingExecution !== undefined
      ));
      if (active?.activeExecution !== undefined) {
        return {
          ...project,
          state: {
            stateId: project.stateId,
            status: active.status,
            activeExecution: active.activeExecution,
          },
        };
      }
      return active?.drainingExecution === undefined
        ? project
        : {
            ...project,
            state: {
              stateId: project.stateId,
              status: active.status,
              drainingExecution: active.drainingExecution,
            },
          };
    } catch (error) {
      warnings.push(`${project.projectDirectory}: central state is unavailable (${errorMessage(error)})`);
      return project;
    }
  }));
  return { projects, warnings };
}

export async function createWebUiServer(options: {
  readonly globalConfigDirectory: string;
  readonly launch: (
    projectDirectory: string,
    request: LaunchRequest,
    project?: RegisteredProject,
  ) => Promise<LaunchResult>;
  readonly requeue?: (
    projectDirectory: string,
    taskId: string,
    project?: RegisteredProject,
  ) => Promise<LaunchResult>;
  readonly taskAction?: (
    projectDirectory: string,
    taskId: string,
    action: CentralTaskAction,
    input: string | undefined,
    conversationId: string | undefined,
    project?: RegisteredProject,
    taskActionClaim?: WebTaskActionClaim,
  ) => Promise<CentralTaskActionResult>;
  readonly taskActionConversation?: (
    projectDirectory: string,
    taskId: string,
    action: 'retry' | 'instruct',
    project?: RegisteredProject,
  ) => Promise<CentralTaskActionResult>;
  readonly getWorkflowCatalog?: (
    projectDirectory: string,
  ) => WebWorkflowCatalog | Promise<WebWorkflowCatalog>;
  readonly chat?: WebChatService;
  readonly pickNativeDirectory?: () => Promise<NativeDirectoryPickerResult>;
  readonly control?: {
    readonly token: string;
    readonly onStopRequested: () => void;
  };
}): Promise<Server> {
  const assets = await loadAssets();
  const sessionToken = randomBytes(24).toString('base64url');
  const chat = options.chat ?? createWebChatService();
  const pickNativeDirectory = options.pickNativeDirectory ?? pickNativeDirectoryOnHost;
  const actionInFlight = new Map<string, Promise<unknown>>();

  const server = createServer(async (request, response) => {
    try {
      const method = request.method;
      const requestUrl = request.url;
      if (requestUrl === undefined) throw new HttpError(400, 'Request URL is missing');
      requireLoopbackOrigin(request);
      const url = new URL(requestUrl, 'http://127.0.0.1');
      const asset = method === 'GET' ? assets.get(url.pathname) : undefined;
      if (asset !== undefined) {
        sendStatic(response, asset);
        return;
      }
      if (method === 'POST' && url.pathname === '/api/control/stop' && options.control !== undefined) {
        requireControlToken(request, options.control.token);
        response.once('finish', options.control.onStopRequested);
        sendJson(response, 202, { stopping: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/session') {
        sendJson(response, 200, {
          token: sessionToken,
          capabilities: { nativeDirectoryPicker: process.platform === 'darwin' },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/projects') {
        sendJson(response, 200, await readProjectDiscovery(options.globalConfigDirectory));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/directories/browse') {
        requireSessionToken(request, sessionToken);
        sendJson(response, 200, await browseRequestedDirectory(await readJsonBody(request)));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/directories/native-picker') {
        requireSessionToken(request, sessionToken);
        const result = await pickNativeDirectory();
        sendJson(response, 200, result.cancelled
          ? result
          : { cancelled: false, directory: await browseDirectory(result.path) });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/projects') {
        requireSessionToken(request, sessionToken);
        sendJson(response, 201, await registerSelectedProject(
          options.globalConfigDirectory,
          await readJsonBody(request),
        ));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/tasks') {
        sendJson(response, 200, await readGlobalTasks(options.globalConfigDirectory));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/tasks/events') {
        await streamSnapshots(
          response,
          () => readGlobalTasks(options.globalConfigDirectory),
          [],
        );
        return;
      }
      const taskActionRoute = method === 'POST' ? routeTaskAction(url.pathname) : null;
      if (taskActionRoute !== null) {
        requireSessionToken(request, sessionToken);
        const body = await readJsonBody(request);
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromBody(body),
        );
        const action = parseCentralTaskAction(taskActionRoute.action);
        const input = optionalActionInput(body);
        const conversationId = optionalConversationId(body);
        const taskActionOptionId = optionalTaskActionOptionId(body);
        const startsConversation = (action === 'retry' || action === 'instruct')
          && input === undefined;
        if (startsConversation && taskActionOptionId !== undefined) {
          throw new HttpError(400, 'taskActionOptionId is only valid when completing a task conversation');
        }
        if (!startsConversation && options.taskAction === undefined) {
          throw new HttpError(501, 'Task actions are unavailable');
        }
        if (startsConversation && options.taskActionConversation === undefined) {
          throw new HttpError(501, 'Task action conversation is unavailable');
        }
        if (!startsConversation && (action === 'retry' || action === 'instruct') && conversationId === undefined) {
          throw new HttpError(409, `${action} must be completed from its task conversation`);
        }
        if (!startsConversation && action !== 'retry' && action !== 'instruct' && taskActionOptionId !== undefined) {
          throw new HttpError(400, 'taskActionOptionId is only valid for retry or instruct');
        }
        const key = `${project.id}:${taskActionRoute.taskId}`;
        if (actionInFlight.has(key)) {
          throw new HttpError(409, 'This task action is already running');
        }
        // Reserve the task key before any asynchronous snapshot validation so
        // different actions cannot pass the check concurrently.
        const reservation = new Promise<CentralTaskActionResult>(() => undefined);
        actionInFlight.set(key, reservation);
        let pending: Promise<CentralTaskActionResult> = reservation;
        let taskActionClaim: WebTaskActionClaim | undefined;
        let taskActionCommitted = false;
        try {
          const task = await verifyTaskActionAvailability(
            options.globalConfigDirectory,
            project,
            taskActionRoute.taskId,
            action,
          );
          if (startsConversation) {
            const startConversation = options.taskActionConversation;
            if (startConversation === undefined) {
              throw new HttpError(501, 'Task action conversation is unavailable');
            }
            pending = startConversation(
              project.projectDirectory,
              taskActionRoute.taskId,
              action,
              project,
            );
          } else {
            if (action === 'retry' || action === 'instruct') {
              if (chat.claimTaskAction === undefined || conversationId === undefined) {
                throw new HttpError(501, 'Task action conversation finalization is unavailable');
              }
              taskActionClaim = chat.claimTaskAction(conversationId, taskActionOptionId);
              assertTaskActionSnapshot(taskActionClaim.context, project, task, action);
              // Availability was checked before claiming the process-local
              // session. Re-read after the claim so a stale terminal record
              // cannot be requeued by a conversation that raced a worker.
              const currentTask = await verifyTaskActionAvailability(
                options.globalConfigDirectory,
                project,
                taskActionRoute.taskId,
                action,
              );
              assertTaskActionSnapshot(taskActionClaim.context, project, currentTask, action);
            }
            if (options.taskAction === undefined) throw new HttpError(501, 'Task actions are unavailable');
            pending = options.taskAction(
              project.projectDirectory,
              taskActionRoute.taskId,
              action,
              input,
              conversationId,
              project,
              taskActionClaim,
            );
          }
          actionInFlight.set(key, pending);
          const result = await pending;
          if (taskActionClaim !== undefined) {
            if (conversationId === undefined) {
              throw new HttpError(500, 'Task action conversation id is missing');
            }
            chat.commitTaskAction(conversationId, taskActionClaim.reservationToken);
            taskActionCommitted = true;
          }
          sendJson(response, result.status === 'accepted' ? 202 : 200, result);
        } catch (error) {
          if (taskActionClaim !== undefined && !taskActionCommitted) {
            releaseTaskActionReservation(
              chat,
              conversationId,
              taskActionClaim.reservationToken,
              error,
            );
          }
          throw error;
        } finally {
          if (actionInFlight.get(key) === pending || actionInFlight.get(key) === reservation) {
            actionInFlight.delete(key);
          }
        }
        return;
      }
      if (method === 'GET' && url.pathname === '/api/workflows') {
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromQuery(url),
        );
        sendJson(
          response,
          200,
          await (
            options.getWorkflowCatalog?.(project.projectDirectory)
            ?? readWorkflowCatalog(project.projectDirectory)
          ),
        );
        return;
      }
      const streamSlug = method === 'GET' ? routeRunStreamSlug(url.pathname) : null;
      if (streamSlug !== null) {
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromQuery(url),
        );
        const repository = await CentralTaskRepository.openByState({
          globalConfigDirectory: options.globalConfigDirectory,
          stateId: project.stateId,
        });
        await streamSnapshots(
          response,
          () => readRunView(options.globalConfigDirectory, project, streamSlug),
          await resolveRunWatchDirectories(repository.paths, streamSlug),
        );
        return;
      }
      const slug = method === 'GET' ? routeRunSlug(url.pathname) : null;
      if (slug !== null) {
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromQuery(url),
        );
        sendJson(
          response,
          200,
          await readRunView(options.globalConfigDirectory, project, slug),
        );
        return;
      }
      const requeueTaskId = method === 'POST' ? routeTaskRequeueId(url.pathname) : null;
      if (requeueTaskId !== null) {
        requireSessionToken(request, sessionToken);
        if (options.requeue === undefined) throw new HttpError(501, 'Task requeue is unavailable');
        const body = await readJsonBody(request);
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromBody(body),
        );
        const key = `${project.id}:${requeueTaskId}`;
        if (actionInFlight.has(key)) {
          throw new HttpError(409, 'This task action is already running');
        }
        const pending = options.requeue(project.projectDirectory, requeueTaskId, project);
        actionInFlight.set(key, pending);
        try {
          sendJson(response, 202, await pending);
        } finally {
          if (actionInFlight.get(key) === pending) actionInFlight.delete(key);
        }
        return;
      }
      if (method === 'POST' && url.pathname === '/api/tasks') {
        requireSessionToken(request, sessionToken);
        const body = await readJsonBody(request);
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromBody(body),
        );
        const launch = parseLaunchBody(body);
        sendJson(response, 202, await options.launch(project.projectDirectory, launch, project));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/chat/sessions') {
        requireSessionToken(request, sessionToken);
        const body = await readJsonBody(request);
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromBody(body),
        );
        sendJson(
          response,
          201,
          chat.create(project.projectDirectory, parseCreateWebChatRequest(body)),
        );
        return;
      }
      const chatSettingsSessionId = method === 'POST'
        ? routeChatSessionId(url.pathname, 'settings')
        : null;
      if (chatSettingsSessionId !== null) {
        requireSessionToken(request, sessionToken);
        sendJson(
          response,
          200,
          chat.reconfigure(
            chatSettingsSessionId,
            parseCreateWebChatRequest(await readJsonBody(request)),
          ),
        );
        return;
      }
      const chatRestartSessionId = method === 'POST'
        ? routeChatSessionId(url.pathname, 'restart')
        : null;
      if (chatRestartSessionId !== null) {
        requireSessionToken(request, sessionToken);
        await readJsonBody(request);
        sendJson(response, 200, chat.restart(chatRestartSessionId));
        return;
      }
      const chatMessageSessionId = method === 'POST'
        ? routeChatSessionId(url.pathname, 'messages')
        : null;
      if (chatMessageSessionId !== null) {
        requireSessionToken(request, sessionToken);
        const message = parseWebChatMessageRequest(await readJsonBody(request));
        if (
          message.taskActionOptionId !== undefined
          && chat.getTaskActionContext !== undefined
          && chat.getTaskActionContext(chatMessageSessionId) === undefined
        ) {
          throw new HttpError(400, 'taskActionOptionId is only valid for task action conversations');
        }
        await streamChatReply(
          response,
          (onThinking) => chat.send(
            chatMessageSessionId,
            message.text,
            onThinking,
            message.taskActionOptionId,
          ),
        );
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.headersSent || response.writableEnded || response.destroyed) {
        if (!response.writableEnded && !response.destroyed) response.end();
        return;
      }
      const httpError = asHttpError(error);
      sendJson(response, httpError.status, { error: httpError.message });
    }
  });
  return server;
}

export function listenWebUiServer(server: Server, port: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('Web UI server did not expose a TCP address'));
        return;
      }
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}
