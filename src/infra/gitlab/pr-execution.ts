import { execFile, execFileSync } from 'node:child_process';
import { z } from 'zod/v4';
import { PR_STATUS_TIMEOUT_MS, PrStatusTimeoutError,
  type PrDetails, type PrStatus, type PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import { isTaktManagedPrBody } from '../git/format.js';
import type { PrListItem, PrSelectionData } from '../git/types.js';

const Id = z.number().int().positive().safe();
const Sha = z.string().regex(/^[0-9a-f]{40}$/u);
const ProjectPath = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u)
  .refine((path) => path.split('/').every((part) => part !== '.' && part !== '..'));
const MrIdentity = z.object({
  iid: Id, project_id: Id, source_project_id: Id.nullable(), target_project_id: Id,
  source_branch: z.string().min(1), target_branch: z.string().min(1), sha: Sha,
});
const MrStatus = MrIdentity.extend({
  state: z.enum(['opened', 'closed', 'locked', 'merged']),
  detailed_merge_status: z.string(),
  head_pipeline: z.object({
    sha: Sha, status: z.string().min(1), project_id: Id, ref: z.string(), source: z.string(),
  }).nullable(),
});
const MrListItem = MrIdentity.omit({ sha: true }).extend({
  state: z.enum(['opened', 'closed', 'locked', 'merged']),
  author: z.object({ username: z.string().min(1) }), description: z.string().nullable(),
  labels: z.array(z.string()), draft: z.boolean(), updated_at: z.string().min(1),
});
const MrSelectionData = MrIdentity.pick({ iid: true, project_id: true, target_project_id: true }).extend({
  title: z.string(), description: z.string().nullable(),
  changes_count: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative().safe()),
});
const MrDiffs = z.array(z.object({ new_path: z.string().min(1) }));
const Project = z.object({ id: Id, path_with_namespace: ProjectPath });
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface Remote {
  readonly url: string;
  readonly prefix: string;
  readonly host: string;
  readonly projectPath: string;
}

interface ParsedRemote {
  readonly url: string;
  readonly prefix: string;
  readonly host: string;
  readonly repositoryPath: string;
  readonly http: boolean;
}

function parseRemote(url: string): ParsedRemote {
  const scp = /^([^\s/@:]+@([^\s/:]+):)([^\s?#]+)$/u.exec(url);
  if (scp) return { url, prefix: scp[1]!, host: scp[2]!, repositoryPath: scp[3]!.replace(/\.git$/u, ''), http: false };
  const parsed = new URL(url);
  if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('Invalid GitLab remote URL');
  }
  const repositoryPath = parsed.pathname.replace(/^\//u, '').replace(/\/$/u, '').replace(/\.git$/u, '');
  return { url, prefix: url.slice(0, url.indexOf(parsed.pathname)) + '/',
    host: parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host, repositoryPath, http: parsed.protocol !== 'ssh:' };
}

function normalizeRemote(remote: ParsedRemote, subfolder: string): Remote {
  const deploymentPath = subfolder.trim().replace(/^\/+|\/+$/gu, '');
  const deploymentPrefix = deploymentPath === '' ? '' : `${deploymentPath}/`;
  const prefix = remote.http && remote.repositoryPath.startsWith(deploymentPrefix) ? deploymentPrefix : '';
  return { url: remote.url, host: remote.host, prefix: remote.prefix + prefix,
    projectPath: ProjectPath.parse(remote.repositoryPath.slice(prefix.length)) };
}

function subfolderArgs(host: string): string[] {
  return ['config', 'get', 'subfolder', '--host', host];
}

function apiArgs(remote: Remote, endpoint: string): string[] {
  return ['api', '--hostname', remote.host, endpoint];
}

function runCommand(command: 'git' | 'glab', args: string[], cwd: string,
  signal: AbortSignal | undefined, deadline: number | undefined): Promise<string> {
  signal?.throwIfAborted();
  if (deadline !== undefined && Date.now() >= deadline) return Promise.reject(new PrStatusTimeoutError());
  return new Promise((resolve, reject) => {
    let terminationError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(command, args, { cwd, encoding: 'utf-8', maxBuffer: MAX_RESPONSE_BYTES }, (error, stdout) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (terminationError !== undefined) reject(terminationError);
      else if (error !== null) reject(error);
      else resolve(stdout.trim());
    });
    // execFileのsignalは終了前にrejectするため、callbackで子プロセスの終了を待つ。
    const terminate = (error: unknown) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.kill('SIGKILL');
    };
    const abort = () => terminate(signal!.reason);
    if (deadline !== undefined) timer = setTimeout(() => terminate(new PrStatusTimeoutError()), Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function readOrigin(cwd: string, signal: AbortSignal | undefined, deadline: number | undefined): Promise<Remote> {
  return readRemote(await runCommand('git', ['remote', 'get-url', 'origin'], cwd, signal, deadline), cwd, signal, deadline);
}

async function readRemote(url: string, cwd: string, signal: AbortSignal | undefined, deadline: number | undefined): Promise<Remote> {
  const remote = parseRemote(url);
  const subfolder = remote.http ? await runCommand('glab', subfolderArgs(remote.host), cwd, signal, deadline) : '';
  return normalizeRemote(remote, subfolder);
}

function readOriginSync(cwd: string): Remote {
  const remote = parseRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8' }).trim());
  const subfolder = remote.http ? execFileSync('glab', subfolderArgs(remote.host), { cwd, encoding: 'utf-8' }) : '';
  return normalizeRemote(remote, subfolder);
}

async function readApi(remote: Remote, endpoint: string, cwd: string,
  signal: AbortSignal | undefined, deadline: number | undefined): Promise<unknown> {
  return JSON.parse(await runCommand('glab', apiArgs(remote, endpoint), cwd, signal, deadline));
}

function mrEndpoint(remote: Remote, number: number): string {
  return `projects/${encodeURIComponent(remote.projectPath)}/merge_requests/${Id.parse(number)}`;
}

function assertMrIdentity(mr: Pick<z.infer<typeof MrIdentity>, 'iid' | 'project_id' | 'target_project_id'>, number: number): void {
  if (mr.iid !== number || mr.project_id !== mr.target_project_id) {
    throw new Error('GitLab response does not match the requested merge request');
  }
}

function headUrl(remote: Remote, source: string, target: string): string {
  if (remote.projectPath === source) return remote.url;
  if (remote.projectPath !== target) throw new Error('Origin does not match the merge request repository');
  return `${remote.prefix}${source}.git`;
}

export async function fetchMrDetails(number: number, cwd: string, signal?: AbortSignal): Promise<PrDetails> {
  const origin = await readOrigin(cwd, signal, undefined);
  const mr = MrIdentity.parse(await readApi(origin, mrEndpoint(origin, number), cwd, signal, undefined));
  assertMrIdentity(mr, number);
  if (mr.source_project_id === null) throw new Error('Merge request source project is unavailable');
  const target = Project.parse(await readApi(origin, `projects/${mr.target_project_id}`, cwd, signal, undefined));
  const source = mr.source_project_id === mr.target_project_id ? target
    : Project.parse(await readApi(origin, `projects/${mr.source_project_id}`, cwd, signal, undefined));
  if (target.id !== mr.target_project_id || source.id !== mr.source_project_id || target.path_with_namespace !== origin.projectPath) {
    throw new Error('GitLab response does not match the requested projects');
  }
  const pushOutput = await runCommand('git', ['remote', 'get-url', '--push', '--all', 'origin'], cwd, signal, undefined);
  const pushUrls: string[] = [];
  for (const url of pushOutput.split(/\r?\n/u)) {
    const pushRemote = await readRemote(url, cwd, signal, undefined);
    pushUrls.push(headUrl(pushRemote, source.path_with_namespace, target.path_with_namespace));
  }
  return { number: mr.iid, headBranch: mr.source_branch, baseBranch: mr.target_branch, headSha: mr.sha,
    sameRepository: source.id === target.id, headRepositoryUrl: headUrl(origin, source.path_with_namespace, target.path_with_namespace),
    headRepositoryPushUrls: pushUrls };
}

export async function fetchMrStatus(number: number, cwd: string, options?: PrStatusFetchOptions): Promise<PrStatus> {
  const deadline = Date.now() + (options?.timeoutMs ?? PR_STATUS_TIMEOUT_MS);
  const signal = options?.signal;
  const origin = await readOrigin(cwd, signal, deadline);
  const mr = MrStatus.parse(await readApi(origin, mrEndpoint(origin, number), cwd, signal, deadline));
  assertMrIdentity(mr, number);
  const pipeline = mr.head_pipeline;
  let matchesHead = pipeline !== null && (pipeline.project_id === mr.target_project_id || pipeline.project_id === mr.source_project_id)
    && pipeline.sha === mr.sha;
  if (pipeline !== null && !matchesHead && pipeline.project_id === mr.target_project_id
    && pipeline.source === 'merge_request_event' && pipeline.ref === `refs/merge-requests/${number}/merge`) {
    const commit = z.object({ id: Sha, parent_ids: z.array(Sha) }).parse(await readApi(origin,
      `projects/${pipeline.project_id}/repository/commits/${pipeline.sha}`, cwd, signal, deadline));
    // GitLabのmerge refはtargetを第1親、sourceを第2親に持つ。
    matchesHead = commit.id === pipeline.sha && commit.parent_ids.length === 2 && commit.parent_ids[1] === mr.sha;
  }
  const finished = matchesHead && pipeline !== null && ['success', 'failed', 'canceled', 'skipped'].includes(pipeline.status);
  return { number: mr.iid, headSha: mr.sha, ci: { finished, passed: finished && pipeline?.status === 'success' },
    mergeable: mr.detailed_merge_status === 'mergeable' ? 'MERGEABLE' : mr.detailed_merge_status === 'conflict' ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: mr.detailed_merge_status === 'mergeable' ? 'CLEAN' : mr.detailed_merge_status,
    reviewDecision: '', merged: mr.state === 'merged' };
}

export function listOpenMrNumbers(cwd: string): number[] {
  const origin = readOriginSync(cwd);
  const numbers = new Set<number>();
  for (let page = 1; ; page += 1) {
    const endpoint = `projects/${encodeURIComponent(origin.projectPath)}/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100&page=${page}`;
    const items = z.array(z.object({ iid: Id })).parse(JSON.parse(execFileSync('glab', apiArgs(origin, endpoint),
      { cwd, encoding: 'utf-8', maxBuffer: MAX_RESPONSE_BYTES })));
    for (const item of items) numbers.add(item.iid);
    if (items.length < 100) return [...numbers];
  }
}

export function fetchMrListItem(number: number, cwd: string): PrListItem | undefined {
  const origin = readOriginSync(cwd);
  const mr = MrListItem.parse(JSON.parse(execFileSync('glab', apiArgs(origin, mrEndpoint(origin, number)),
    { cwd, encoding: 'utf-8', maxBuffer: MAX_RESPONSE_BYTES })));
  assertMrIdentity(mr, number);
  if (mr.state !== 'opened') return undefined;
  return { number: mr.iid, author: mr.author.username, base_branch: mr.target_branch, head_branch: mr.source_branch,
    managed_by_takt: isTaktManagedPrBody(mr.description), labels: mr.labels,
    same_repository: mr.source_project_id === mr.target_project_id, draft: mr.draft, updated_at: mr.updated_at };
}

export function fetchMrSelectionData(number: number, cwd: string): PrSelectionData {
  const origin = readOriginSync(cwd);
  const endpoint = mrEndpoint(origin, number);
  const mr = MrSelectionData.parse(JSON.parse(execFileSync('glab', apiArgs(origin, endpoint),
    { cwd, encoding: 'utf-8', maxBuffer: MAX_RESPONSE_BYTES })));
  assertMrIdentity(mr, number);
  const files = new Set<string>();
  for (let page = 1; ; page += 1) {
    const diffs = MrDiffs.parse(JSON.parse(execFileSync('glab', apiArgs(origin, `${endpoint}/diffs?per_page=100&page=${page}`),
      { cwd, encoding: 'utf-8', maxBuffer: MAX_RESPONSE_BYTES })));
    for (const diff of diffs) {
      if (files.has(diff.new_path)) throw new Error('GitLab returned duplicate merge request file paths');
      files.add(diff.new_path);
    }
    if (files.size > mr.changes_count) throw new Error('GitLab merge request file count does not match changes_count');
    if (diffs.length < 100) break;
  }
  if (files.size !== mr.changes_count) throw new Error('GitLab merge request file list is incomplete');
  return { number: mr.iid, title: mr.title, body: mr.description ?? '', files: [...files] };
}
