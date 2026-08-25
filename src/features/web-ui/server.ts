import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  readProjectRegistry,
  registerProject,
  resolveRegisteredProject,
  type RegisteredProject,
} from '../../infra/config/global/projectRegistry.js';
import { readRunCollection, readRunDetail } from './run-store.js';
import { parseLaunchRequest, type LaunchRequest, type LaunchResult } from './launcher.js';
import {
  createWebChatService,
  parseCreateWebChatRequest,
  parseWebChatMessage,
  WebChatInputError,
  type WebChatService,
} from './chat.js';
import { readWorkflowCatalog, type WebWorkflowCatalog } from './workflow-catalog.js';
import { browseDirectory, parseDirectoryBrowseRequest } from './directory-browser.js';
import {
  NativeDirectoryPickerUnavailableError,
  pickNativeDirectoryOnHost,
  type NativeDirectoryPickerResult,
} from './native-directory-picker.js';
import { resolveStatePaths } from '../../core/execution/locations.js';
import { CentralTaskBusyError, CentralTaskRepository, parseCentralTasks } from '../../infra/task/centralStateRepository.js';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_GLOBAL_RUNS = 100;

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
  if (request.headers['x-takt-web-token'] !== sessionToken) {
    throw new HttpError(403, 'Session token is invalid');
  }
}

async function loadAssets() {
  const definitions = [
    ['/', '../../../web-ui/public/index.html', 'text/html; charset=utf-8'],
    ['/app.js', '../../../web-ui/public/app.js', 'text/javascript; charset=utf-8'],
    ['/api.js', '../../../web-ui/public/api.js', 'text/javascript; charset=utf-8'],
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

async function readGlobalRuns(globalConfigDirectory: string) {
  const registry = await readProjectRegistry(globalConfigDirectory);
  const results = await Promise.all(registry.projects.map(async (project) => {
    if (!project.available) {
      return { runs: [], warnings: [`${project.projectDirectory}: project directory is unavailable`] };
    }
    try {
      const statePaths = resolveStatePaths(globalConfigDirectory, project.stateId);
      if (!existsSync(statePaths.runsDirectory) || !existsSync(statePaths.stateFile)) {
        return { runs: [], warnings: [] };
      }
      const repository = await CentralTaskRepository.openByState({
        globalConfigDirectory,
        stateId: project.stateId,
      });
      const collection = await readRunCollection(repository.paths);
      return {
        runs: collection.runs.map((run) => ({
          ...run,
          projectId: project.locationId,
          locationId: project.locationId,
          stateId: project.stateId,
          projectName: project.displayName,
          projectDirectory: project.projectDirectory,
        })),
        warnings: collection.warnings.map((warning) => `${project.displayName}: ${warning}`),
      };
    } catch (error) {
      return {
        runs: [],
        warnings: [`${project.projectDirectory}: ${errorMessage(error)}`],
      };
    }
  }));
  return {
    runs: results
      .flatMap((result) => result.runs)
      .sort((left, right) => right.startTime.localeCompare(left.startTime))
      .slice(0, MAX_GLOBAL_RUNS),
    warnings: [...registry.warnings, ...results.flatMap((result) => result.warnings)],
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
      const active = tasks.find((task) => task.status === 'starting' || task.status === 'running');
      return active?.activeExecution === undefined
        ? project
        : { ...project, state: { stateId: project.stateId, status: active.status, activeExecution: active.activeExecution } };
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
  readonly getWorkflowCatalog?: (
    projectDirectory: string,
  ) => WebWorkflowCatalog | Promise<WebWorkflowCatalog>;
  readonly chat?: WebChatService;
  readonly pickNativeDirectory?: () => Promise<NativeDirectoryPickerResult>;
}): Promise<Server> {
  const assets = await loadAssets();
  const sessionToken = randomBytes(24).toString('base64url');
  const chat = options.chat ?? createWebChatService();
  const pickNativeDirectory = options.pickNativeDirectory ?? pickNativeDirectoryOnHost;

  return createServer(async (request, response) => {
    try {
      const method = request.method;
      const requestUrl = request.url;
      if (requestUrl === undefined) throw new HttpError(400, 'Request URL is missing');
      const url = new URL(requestUrl, 'http://127.0.0.1');
      const asset = method === 'GET' ? assets.get(url.pathname) : undefined;
      if (asset !== undefined) {
        sendStatic(response, asset);
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
      if (method === 'GET' && url.pathname === '/api/runs') {
        sendJson(response, 200, await readGlobalRuns(options.globalConfigDirectory));
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
      const slug = method === 'GET' ? routeRunSlug(url.pathname) : null;
      if (slug !== null) {
        const project = await resolveProject(
          options.globalConfigDirectory,
          projectIdFromQuery(url),
        );
        const repository = await CentralTaskRepository.openByState({
          globalConfigDirectory: options.globalConfigDirectory,
          stateId: project.stateId,
        });
        sendJson(response, 200, {
          project,
          ...await readRunDetail(repository.paths, slug),
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/runs') {
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
        sendJson(
          response,
          200,
          await chat.send(
            chatMessageSessionId,
            parseWebChatMessage(await readJsonBody(request)),
          ),
        );
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const httpError = asHttpError(error);
      sendJson(response, httpError.status, { error: httpError.message });
    }
  });
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
