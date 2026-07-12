/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentResponse } from '../../core/models/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { mapsToOpenCodeEditPermission } from './allowedTools.js';
import { AskUserQuestionDeniedError } from '../../core/workflow/ask-user-question-error.js';
import { parseLastJsonBlock } from '../../agents/structured-caller/shared.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, type StreamDiagnostics } from '../../shared/utils/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  runWithNestedObservabilityProcessEnv,
} from '../../shared/telemetry/index.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';
import {
  buildOpenCodePermissionRuleset,
  buildOpenCodePromptTools,
  buildOpenCodeSessionPermission,
  resolveOpenCodePermissionReply,
  type OpenCodeCompactSessionOptions,
  type OpenCodeCallOptions,
} from './types.js';
import {
  type OpenCodeStreamEvent,
  type OpenCodePart,
  type OpenCodeTextPart,
  type OpenCodeToolPart,
  createStreamTrackingState,
  emitInit,
  emitText,
  emitPermissionAsked,
  emitPermissionSummary,
  emitResult,
  handlePartUpdated,
} from './OpenCodeStreamHandler.js';
import {
  OpenCodeToolGuard,
  buildEditConflictCorrectionPrompt,
  buildToolGuardRetryPrompt,
  clearToolGuardPendingCorrection,
  createToolGuardRecoveryState,
  markToolGuardCorrectionPending,
  markToolGuardFreshSessionUsed,
  shouldIssueEditConflictCorrection,
  type ToolGuardFailure,
} from './tool-guard.js';
import {
  buildFormatlessStructuredPrompt,
  createStructuredOutputRecoveryState,
  degradeToFormatless,
  planStructuredOutputAttempt,
  recoverStaleSession,
  shouldDegradeToFormatless,
  shouldRecoverStaleSession,
} from './structured-output-recovery.js';
import {
  buildUnavailableToolRetryPrompt,
  createUnavailableToolRecoveryState,
  markUnavailableToolRecoveryUsed,
  parseServerAvailableTools,
  shouldRecoverUnavailableToolLoop,
} from './unavailable-tool-recovery.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';
import { isSensitiveKeyName, sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { versionAllowsListToolShim } from './list-tool-shim-guard.js';

export type { OpenCodeCallOptions } from './types.js';

const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';

/**
 * イベントが属するセッション ID を取り出す。イベントバスはサーバ全体で
 * 共有されるため、無音検出のリセットは「自セッションの進捗」だけに
 * 反応させる必要がある（LSP・ファイルウォッチャ・兄弟セッションの
 * イベントでリセットすると、生成が死んでいても永遠にハングする）。
 */
function extractEventSessionId(event: OpenCodeStreamEvent): string | undefined {
  const props = event.properties as Record<string, unknown> | undefined;
  if (!props) return undefined;
  if (typeof props.sessionID === 'string') return props.sessionID;
  const part = props.part as { sessionID?: unknown } | undefined;
  if (part !== undefined && typeof part.sessionID === 'string') return part.sessionID;
  const info = props.info as { sessionID?: unknown } | undefined;
  if (info !== undefined && typeof info.sessionID === 'string') return info.sessionID;
  return undefined;
}

/**
 * 失敗したツール呼び出しの引数（state.input）をログへ残す前にマスクする。
 * bash の command、edit の内容、認証ヘッダーなどの機密情報がそのまま
 * debug ログに残り得るため（未加工での出力を指摘された）。
 *
 * このログの目的は「モデルが引数をどう壊したか」を後から特定すること
 * （実測: qwen が read に offset: "290.0" という文字列を、edit に
 * filepaath という誤字キーを渡していた）。JSON.stringify で丸ごと
 * 文字列化するとキー名・値の型が読みにくくなるため、オブジェクト構造は
 * 保ったまま文字列値だけを sanitizeSensitiveText() でマスクする
 * （ParallelRunner.ts と同じ関数を使う）。
 *
 * ただし sanitizeSensitiveText() はテキスト中の「キー名: 値」という並びを
 * 正規表現で検出する実装のため、値を単独の文字列として渡すとキーの文脈が
 * 失われ、{ password: "hunter2" } や { Authorization: "Bearer opaque-value" }
 * のような非定型の値がマスクされずに残ってしまう（実測）。そのためオブジェクトの
 * 走査時はキー名も一緒に伝播させ、isSensitiveKeyName() が機密キーと判定した
 * 場合は値の形式・型を問わず丸ごと [REDACTED] に置き換える。該当しないキーの
 * 文字列値は従来どおり sanitizeSensitiveText() を通す（sk-... のような値自体の
 * 形でマスクされるものを拾うため）。
 */
/**
 * edit ツールの本文引数。ソースコード断片がそのまま入るため、debug ログには
 * 本文を残さず {sha256 先頭12桁, length} に置き換える（tool-guard の
 * edit conflict 署名と同じ「本文非露出・ハッシュのみ」の規約）。filePath 等の
 * 他の引数は従来どおり残す — このログは「モデルが引数をどう壊したか」を後から
 * 特定するツール失敗デバッグ機能の本体であり、消してはならない。
 */
const EDIT_CONTENT_INPUT_KEYS = new Set(['oldstring', 'newstring']);

function maskEditContentForLogging(value: string): { sha256: string; length: number } {
  return {
    sha256: createHash('sha256').update(value).digest('hex').slice(0, 12),
    length: value.length,
  };
}

/**
 * エラー文そのものに edit 本文が引用される経路を閉じる（codex 2巡目ブロッカー）。
 *
 * OpenCode の edit エラー文は oldString の内容を含むことがあり、入力側の
 * マスク（sanitizeToolCallInputForLogging）だけでは閉じない。state.error は
 * sanitizeSensitiveText()（API キー等のパターンマスク）しか通らないため、
 * 当該ツールコールの input に含まれる oldString/newString の実値がエラー文中に
 * 現れたら {sha256:先頭12桁,length:N} プレースホルダへ置換する。tool 失敗の
 * 観測時点でこの関数を通し、マスク済みのエラー文だけを downstream
 * （debug ログ・ToolGuardFailure.message → AgentResponse.error・correction 文・
 * stats）に流す。
 *
 * ごく短い値（例: 1〜2 文字の oldString）は置換するとエラー文全体が壊れる
 * 一方で漏えいとしての意味を持たないため、閾値未満はそのままにする。
 */
const EDIT_CONTENT_ERROR_MASK_MIN_LENGTH = 6;

function maskEditContentInErrorText(error: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return error;
  }
  let masked = error;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!EDIT_CONTENT_INPUT_KEYS.has(key.toLowerCase()) || typeof value !== 'string') {
      continue;
    }
    if (value.length < EDIT_CONTENT_ERROR_MASK_MIN_LENGTH || !masked.includes(value)) {
      continue;
    }
    const { sha256, length } = maskEditContentForLogging(value);
    masked = masked.split(value).join(`{sha256:${sha256},length:${length}}`);
  }
  return masked;
}

function sanitizeToolCallInputForLogging(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKeyName(key)) {
    return '[REDACTED]';
  }
  if (key !== undefined && EDIT_CONTENT_INPUT_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
    return maskEditContentForLogging(value);
  }
  if (typeof value === 'string') {
    return sanitizeSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolCallInputForLogging(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, sanitizeToolCallInputForLogging(entry, entryKey)]),
    );
  }
  return value;
}

function selectTaktAgent(allowedTools: readonly string[] | undefined): string {
  if (allowedTools !== undefined && allowedTools.length === 0) {
    return TAKT_AGENT_REPORT;
  }
  const hasBash = allowedTools === undefined
    || allowedTools.some((t) => t.trim().toLowerCase() === 'bash');
  const hasEdit = allowedTools === undefined
    || allowedTools.some((t) => mapsToOpenCodeEditPermission(t));
  if (hasEdit && hasBash) {
    return TAKT_AGENT;
  }
  return TAKT_AGENT_REVIEW;
}

const log = createLogger('opencode-sdk');

/**
 * ツール引数を矯正するプラグインの絶対パス。
 *
 * OpenCode はプラグインをファイルパスでしか受け取らないが、config.plugin に
 * 絶対パスを渡せば cwd の .opencode/plugin を作らずに読み込ませられる。
 * ユーザーのリポジトリを汚さないための経路。
 */
function coerceToolArgsPluginPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins', 'coerce-tool-args.js');
}

function listToolShimPluginPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins', 'list-tool.js');
}

/**
 * opencode バイナリのバージョン（`opencode --version`）。プロセス内で1回だけ
 * 解決する。バイナリはプロセス寿命中に変わらない前提。失敗（未インストール・
 * タイムアウト）は undefined = シム登録の fail-closed。
 */
let opencodeBinaryVersionPromise: Promise<string | undefined> | undefined;

function resolveOpenCodeBinaryVersion(): Promise<string | undefined> {
  opencodeBinaryVersionPromise ??= new Promise((resolvePromise) => {
    execFile('opencode', ['--version'], { timeout: 10_000 }, (error, stdout) => {
      resolvePromise(error ? undefined : String(stdout).trim());
    });
  });
  return opencodeBinaryVersionPromise;
}

/**
 * 'list' 互換シムを登録してよいか（upstream 衝突ガード）。
 * 判定基準と fail-closed の設計は list-tool-shim-guard.ts を参照。
 */
async function shouldRegisterListToolShim(): Promise<boolean> {
  const version = await resolveOpenCodeBinaryVersion();
  if (version === undefined) {
    return false;
  }
  const allowed = versionAllowsListToolShim(version);
  log.debug('OpenCode list tool shim decision', { version, allowed });
  return allowed;
}

/**
 * OpenCode がツール呼び出しを拒否したときの、ツール名とエラー文を取り出す。
 *
 * OpenCode は2種類の拒否を `invalid` という擬似ツールの **status: 'completed'**
 * として返す。存在しないツール名（`Model tried to call unavailable tool 'run'`）と、
 * 実在ツールの引数不備（`Required argument 'filePath' is missing or invalid`）。
 *
 * 3 つの検出器はどれも status === 'error' でしか観測しないため、拒否がまるごと
 * 死角に入る。実測: qwen が implement で 195 回連続して invalid を踏み、
 * ループ検出も引数不正検出もエラー予算も一度も発火せず、cycle budget を
 * 焼き切って abort した。しかも invalid は completed なので「ツールが成功した」
 * として空転の計数までリセットしていた。
 *
 * 本来呼ぼうとしたツール名は state.input.tool に入っている。検出器は連続性と
 * 総量で判断するので、1〜2 回の空振り（モデルが自力で直す場合）では発火しない。
 */
function extractOpenCodeToolRejection(
  toolPart: OpenCodeToolPart,
): { tool: string; error: string } | undefined {
  if (toolPart.state.status === 'error') {
    return { tool: toolPart.tool, error: toolPart.state.error };
  }
  if (toolPart.tool !== 'invalid' || toolPart.state.status !== 'completed') {
    return undefined;
  }
  const input = toolPart.state.input as { tool?: unknown; error?: unknown } | undefined;
  const attemptedTool = typeof input?.tool === 'string' ? input.tool : 'invalid';
  const error = typeof input?.error === 'string'
    ? input.error
    : (typeof toolPart.state.output === 'string' ? toolPart.state.output : 'OpenCode rejected the tool call');
  return { tool: attemptedTool, error };
}

/** 呼び出し時に評価する（テストや実験で env から上書きできるようにする） */
function resolveMessageCycleBudget(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET);
  return fromEnv > 0 ? fromEnv : 120;
}

/** 呼び出し時に評価する（テストや実験で env から上書きできるようにする） */
function resolveStreamIdleTimeoutMs(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : 10 * 60 * 1000;
}
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
const OPENCODE_SERVER_START_TIMEOUT_MS = 60000;
const OPENCODE_RETRYABLE_ERROR_PATTERNS = [
  'stream disconnected before completion',
  'transport error',
  'network error',
  'error decoding response body',
  'econnreset',
  'etimedout',
  'eai_again',
  'fetch failed',
  'failed to start server on port',
  'timeout waiting for server',
];
type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];
type OpenCodeSessionSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient['session']['get']>>['data']>;
type OpenCodeAbortCause = 'timeout' | 'external' | 'prompt';

interface SharedServer {
  client: OpencodeClient;
  close: () => void;
  model: string;
  apiKey?: string;
  busy: boolean;
  queue: SharedServerQueueEntry[];
}

interface SharedServerQueueEntry {
  resolve: (acquired: AcquiredOpenCodeClient) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface SharedServerEntry {
  server?: SharedServer;
  initPromise?: Promise<SharedServer>;
}

interface AcquiredOpenCodeClient {
  client: OpencodeClient;
  release: () => void;
}

const sharedServers = new Map<string, SharedServerEntry>();

async function acquireClient(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  abortSignal?: AbortSignal,
): Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  const key = buildSharedServerKey(model, apiKey, childProcessEnv);
  const entry = getSharedServerEntry(key);

  if (entry.initPromise) {
    const server = await entry.initPromise;
    throwIfAborted(abortSignal);
    return acquireSharedServer(server, abortSignal);
  }

  if (entry.server) {
    return acquireSharedServer(entry.server, abortSignal);
  }

  entry.initPromise = createSharedServer(model, apiKey, childProcessEnv)
    .then((server) => {
      entry.server = server;
      return server;
    })
    .finally(() => {
      entry.initPromise = undefined;
    });

  const server = await entry.initPromise;
  throwIfAborted(abortSignal);
  return acquireSharedServer(server, abortSignal);
}

function buildSharedServerKey(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify([model, apiKey, getNestedObservabilityEnvFingerprint(childProcessEnv)]);
}

function getSharedServerEntry(key: string): SharedServerEntry {
  const existing = sharedServers.get(key);
  if (existing) {
    return existing;
  }

  const entry: SharedServerEntry = {};
  sharedServers.set(key, entry);
  return entry;
}

async function createSharedServer(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Promise<SharedServer> {
  const port = await getFreePort();
  // v3-r4: ローカルモデルが実在しない 'list' を呼び続けて確定失敗した。
  // registry に 'list' が無いと実測済みのバージョンに限り、互換シムを登録する。
  const registerListToolShim = await shouldRegisterListToolShim();
  const { client, server } = await runWithNestedObservabilityProcessEnv(childProcessEnv, () =>
    createOpencode({
      port,
      config: {
        model,
        small_model: model,
        // ローカルモデルが送る数値の型違い（"290.0"）を実行直前に矯正する。
        // OpenCode 本体は強制変換せず SchemaError で落とすため、これが無いと
        // 弱いモデルは同じ呼び出しを繰り返して cycle budget を使い切る。
        plugin: [
          coerceToolArgsPluginPath(),
          ...(registerListToolShim ? [listToolShimPluginPath()] : []),
        ],
        // Session-level permission rules are rewritten whenever a prompt
        // carries a tools map (OpenCode materializes the map into
        // session.permission), so session-scoped denies do not survive the
        // first prompt. Server-config permission is outside that rewrite and
        // is the only layer that reliably keeps out-of-workspace access a
        // soft tool error instead of an ask (which would depend on the
        // user's global OpenCode config).
        permission: { external_directory: 'deny' },
        ...(apiKey ? { provider: { opencode: { options: { apiKey } } } } : {}),
        // agent プロンプトは OpenCode 既定（英語）を土台にしているため言語を切り替えない。
        // ja 版は誰も読まないまま古びて食い違いを生むので置いていない。
        agent: {
          [TAKT_AGENT]: {
            prompt: loadTemplate('opencode_agent_prompt', 'en', {
              listFilesMethod: 'runs bash ls to list files in the directory',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REVIEW]: {
            prompt: loadTemplate('opencode_review_agent_prompt', 'en', {
              listFilesMethod: 'uses read tool on the directory to list files',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REPORT]: {
            prompt: loadTemplate('opencode_report_agent_prompt', 'en'),
          },
        },
      },
      timeout: OPENCODE_SERVER_START_TIMEOUT_MS,
    })
  );
  log.debug('OpenCode server started with TAKT agents', {
    agents: [TAKT_AGENT, TAKT_AGENT_REVIEW, TAKT_AGENT_REPORT],
    model,
    port,
  });

  const closeServer = (): void => {
    try {
      server.close();
    } catch (error) {
      log.debug(`Failed to close OpenCode server: ${getErrorMessage(error)}`, { model });
    }
  };

  log.debug('OpenCode server started', { model, port });
  return { client, close: closeServer, model, apiKey, busy: false, queue: [] };
}

function acquireSharedServer(
  server: SharedServer,
  abortSignal?: AbortSignal,
): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  if (!server.busy) {
    server.busy = true;
    return { client: server.client, release: createReleaseHandle(server) };
  }

  return new Promise((resolve, reject) => {
    const entry: SharedServerQueueEntry = { resolve, reject, signal: abortSignal };
    if (abortSignal) {
      entry.onAbort = () => {
        removeQueuedClient(server, entry);
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };
      abortSignal.addEventListener('abort', entry.onAbort, { once: true });
    }
    server.queue.push(entry);
  });
}

export async function getOpenCodeSessionSnapshot(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionSnapshot> {
  const { client, release } = await acquireClient(model, apiKey, undefined);
  try {
    const result = await client.session.get({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

export type OpenCodeSessionMessages = NonNullable<Awaited<ReturnType<OpencodeClient['session']['messages']>>['data']>;

/** レート制限を示す HTTP ステータス。プロバイダは 429 を返す。 */
const RATE_LIMIT_STATUS_CODE = 429;

/**
 * 検死 RPC の上限。検死自体がハングして再度の無限待ちを招かないようにする。
 * 呼び出し時に評価する（テストで env から上書きできるようにする）。
 */
function resolvePostmortemTimeoutMs(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : 5000;
}

/** statusCode は数値でも文字列でも来うるため正規化する。 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const data = (error as { data?: { statusCode?: unknown } }).data;
  const raw = data?.statusCode;
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 直近の assistant メッセージのエラーを検死し、レート制限ならその内容を返す。
 *
 * OpenCode サーバはプロバイダの 429 を内部リトライで握り、イベントバスへ
 * session.error を流さない。takt からは「無音のまま停止したセッション」に
 * 見えるため、無音ウォッチドッグのタイムアウト後にここで死因を確かめる。
 *
 * 判定するのは「最新の assistant メッセージ」だけに限る。sessionId は phase や
 * resume で再利用されるため、過去の assistant に残る古い 429 を今回の死因と
 * 誤認しないようにする。
 */
async function postmortemRateLimitError(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<string | undefined> {
  let messages: OpenCodeSessionMessages;
  try {
    const result = await withTimeout(
      (signal) => client.session.messages({ sessionID, directory }, { signal }),
      resolvePostmortemTimeoutMs(),
      'OpenCode rate limit postmortem timed out',
    );
    if (!result.data) {
      return undefined;
    }
    messages = result.data;
  } catch (error) {
    // 検死そのものの失敗（RPC エラー・ハング）で本来のエラーを覆い隠さない。
    log.debug('Rate limit postmortem could not read session messages', {
      sessionID,
      error: getErrorMessage(error),
    });
    return undefined;
  }

  // 末尾が assistant でないなら、今回のターンの応答はまだ作られていない。
  // ここで過去へ遡ると、セッション再利用時に前回ターンの 429 を今回の死因と
  // 誤認する（[前回 assistant 429, 今回 user prompt] のまま無音停止する形）。
  const latestInfo = messages[messages.length - 1]?.info;
  if (latestInfo?.role !== 'assistant') {
    return undefined;
  }
  const error = latestInfo.error;
  if (error === undefined) {
    return undefined;
  }
  const message = extractOpenCodeErrorMessage(error);
  if (extractStatusCode(error) === RATE_LIMIT_STATUS_CODE) {
    return message ?? `HTTP ${RATE_LIMIT_STATUS_CODE} Too Many Requests`;
  }
  if (message !== undefined && containsRateLimitError(message)) {
    return message;
  }
  return undefined;
}

export async function getOpenCodeSessionMessages(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionMessages> {
  const { client, release } = await acquireClient(model, apiKey, undefined);
  try {
    const result = await client.session.messages({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session messages not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

function releaseClient(server: SharedServer): void {
  const next = server.queue.shift();
  if (next) {
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve({ client: server.client, release: createReleaseHandle(server) });
    return;
  }
  server.busy = false;
}

function removeQueuedClient(server: SharedServer, entry: SharedServerQueueEntry): void {
  server.queue = server.queue.filter((queued) => queued !== entry);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
  }
}

function createExternalAbortPromise(
  controller: AbortController,
  externalAbortSignal: AbortSignal | undefined,
): { promise?: Promise<never>; removeListener?: () => void } {
  if (externalAbortSignal === undefined) {
    return {};
  }
  let removeListener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const onExternalAbort = (): void => {
      reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      controller.abort();
    };
    if (externalAbortSignal.aborted) {
      onExternalAbort();
      return;
    }
    externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    removeListener = () => externalAbortSignal.removeEventListener('abort', onExternalAbort);
  });
  return { promise, removeListener };
}

function createReleaseHandle(server: SharedServer): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseClient(server);
  };
}

export function resetSharedServer(): void {
  for (const entry of sharedServers.values()) {
    entry.server?.close();
  }
  sharedServers.clear();
}

/** 要約は本文量に比例して伸びるため、対話 RPC より長く待つ。 */
const OPENCODE_SUMMARY_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
const OPENCODE_SUMMARY_POLL_INTERVAL_MS = 500;

/**
 * summarize() を呼ぶ前に存在していた要約メッセージの id を控える。
 *
 * sessionId は phase や resume で再利用され、過去の要約メッセージが履歴に
 * 残り続ける。「履歴上の最新の要約」を今回の要約と見なすと、今回の要約が
 * 履歴に現れる前の最初のポーリングで過去の要約を拾い、過去が失敗していれば
 * 即例外、成功していれば今回の完了を待たずに戻ってしまう。
 */
async function collectExistingSummaryIds(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  abortSignal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const result = await withTimeout(
    (signal) => client.session.messages({ sessionID, directory }, { signal }),
    OPENCODE_INTERACTION_TIMEOUT_MS,
    'OpenCode session messages timed out',
    abortSignal,
  );
  if (result.data === undefined) {
    throw new Error(`OpenCode session messages not readable before summarize: ${sessionID}`);
  }
  const ids = new Set<string>();
  for (const message of result.data) {
    const info = message.info as { id?: string; summary?: boolean } | undefined;
    if (info?.summary !== true) {
      continue;
    }
    // AssistantMessage.id は SDK の型で必須。欠けているなら契約違反であり、
    // id で今回の要約を識別できない以上、過去の要約を今回のものと取り違える。
    if (typeof info.id !== 'string') {
      throw new Error(`OpenCode summary message has no id: ${sessionID}`);
    }
    ids.add(info.id);
  }
  return ids;
}

async function waitForSummaryToComplete(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  existingSummaryIds: ReadonlySet<string>,
  abortSignal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + OPENCODE_SUMMARY_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted === true) {
      throw new Error('OpenCode session summarize aborted');
    }

    const result = await withTimeout(
      (signal) => client.session.messages({ sessionID, directory }, { signal }),
      OPENCODE_INTERACTION_TIMEOUT_MS,
      'OpenCode session messages timed out',
      abortSignal,
    );

    // data が無いのは「要約が無い」ではなく「読めなかった」。
    // 要約中のまま先へ進むと後続のツール呼び出しが全て拒否されるため、
    // 判定できないときは黙って通さない。
    if (result.data === undefined) {
      throw new Error(`OpenCode session messages not readable while waiting for summary: ${sessionID}`);
    }

    // 判定対象は「今回の summarize() が作った要約」だけ。呼び出し前に存在した
    // 要約は id で除外する。履歴上の最新を今回のものと見なすと、今回の要約が
    // 履歴に現れる前の最初のポーリングで過去の要約を拾ってしまう。
    const latestSummaryMessage = [...result.data].reverse().find((message) => {
      const info = message.info as { id?: string; summary?: boolean } | undefined;
      if (info?.summary !== true) {
        return false;
      }
      if (typeof info.id !== 'string') {
        throw new Error(`OpenCode summary message has no id: ${sessionID}`);
      }
      return !existingSummaryIds.has(info.id);
    });

    if (latestSummaryMessage === undefined) {
      // 今回の要約はまだ履歴に現れていない。summarize() は要約対象が無くても
      // 必ず要約メッセージを作る（実測: メッセージ 0 件のセッションでも 1 秒後に
      // 1 件現れる）。したがって現れないのは異常であり、勝手に「要約不要」と
      // みなして先へ進めてはいけない。全体タイムアウトまで待つ。
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_SUMMARY_POLL_INTERVAL_MS));
      continue;
    }

    // 要約メッセージが time.completed を持っていても、それは「終了した」だけで
    // 「成功した」ではない。OpenCode はエラー終了した要約にも completed
    // タイムスタンプを付けるため、info.error を見ずに time.completed だけで
    // 判定すると、要約失敗を成功と誤認して未圧縮のコンテキストのまま次の
    // プロンプトへ進み、同じ理由で再度失敗する（実測）。
    const latestInfo = latestSummaryMessage.info as { error?: unknown; time?: { completed?: number } };
    if (latestInfo.error !== undefined) {
      const detail = extractOpenCodeErrorMessage(latestInfo.error) ?? 'unknown error';
      throw new Error(`OpenCode session summarize failed: ${detail}`);
    }
    if (latestInfo.time?.completed !== undefined) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, OPENCODE_SUMMARY_POLL_INTERVAL_MS));
  }

  throw new Error('OpenCode session summarize did not finish in time');
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutErrorMessage: string,
  externalAbortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);
  });
  const externalAbort = createExternalAbortPromise(controller, externalAbortSignal);
  try {
    const operationPromise = operation(controller.signal).catch((error: unknown) => {
      if (timedOut) {
        return new Promise<never>(() => {
          // The timeout promise owns the rejection after aborting the SDK call.
        });
      }
      throw error;
    });
    const racePromises = externalAbort.promise !== undefined
      ? [operationPromise, timeoutPromise, externalAbort.promise]
      : [operationPromise, timeoutPromise];
    return await Promise.race(racePromises);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    externalAbort.removeListener?.();
  }
}

function extractOpenCodeErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = error as { message?: unknown; data?: { message?: unknown }; name?: unknown };
  if (typeof value.message === 'string' && value.message.length > 0) {
    return value.message;
  }
  if (typeof value.data?.message === 'string' && value.data.message.length > 0) {
    return value.data.message;
  }
  if (typeof value.name === 'string' && value.name.length > 0) {
    return value.name;
  }
  return undefined;
}

function stripPromptEcho(
  chunk: string,
  echoState: { remainingPrompts: string[] },
): string {
  if (!chunk) return '';
  if (echoState.remainingPrompts.length === 0) return chunk;

  const matchingPrompts = echoState.remainingPrompts.filter((remainingPrompt) => (
    remainingPrompt.startsWith(chunk) || chunk.startsWith(remainingPrompt)
  ));
  if (matchingPrompts.length === 0) {
    echoState.remainingPrompts = [];
    return chunk;
  }

  const consumedPrompt = matchingPrompts
    .filter((remainingPrompt) => chunk.startsWith(remainingPrompt))
    .sort((a, b) => b.length - a.length)[0];
  if (consumedPrompt !== undefined) {
    const visible = chunk.slice(consumedPrompt.length);
    echoState.remainingPrompts = [];
    return visible;
  }

  echoState.remainingPrompts = matchingPrompts.map((remainingPrompt) => (
    remainingPrompt.slice(chunk.length)
  ));
  return '';
}

function buildPromptEchoCandidates(prompt: string, systemPrompt: string | undefined): string[] {
  const prompts = [prompt];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    prompts.unshift(`${systemPrompt}\n\n${prompt}`);
  }

  return Array.from(new Set(prompts)).filter((candidate) => candidate.length > 0);
}

type OpenCodeQuestionOption = {
  label: string;
  description: string;
};

type OpenCodeQuestionInfo = {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
};

type OpenCodeQuestionAskedProperties = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
};

function toQuestionInput(props: OpenCodeQuestionAskedProperties): {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
} {
  return {
    questions: props.questions.map((item) => ({
      question: item.question,
      header: item.header,
      options: item.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
      multiSelect: item.multiple,
    })),
  };
}

function toQuestionAnswers(
  props: OpenCodeQuestionAskedProperties,
  answers: Record<string, string>,
): Array<Array<string>> {
  return props.questions.map((item) => {
    const key = item.header || item.question;
    const value = answers[key];
    if (!value) return [];
    return [value];
  });
}

function buildPermissionRejectedMessage(permission: string | undefined): string {
  if (permission && permission.length > 0) {
    return `OpenCode permission rejected: ${permission}`;
  }
  return 'OpenCode permission rejected';
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate free TCP port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Client for OpenCode SDK agent interactions.
 *
 * Handles session management, streaming event conversion,
 * permission auto-reply, and response processing.
 */
export class OpenCodeClient {
  private isRetriableError(message: string, aborted: boolean, abortCause?: OpenCodeAbortCause): boolean {
    if (abortCause === 'timeout') {
      return true;
    }

    if (abortCause === 'prompt') {
      const lower = message.toLowerCase();
      return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
    }

    if (aborted || abortCause) {
      return false;
    }

    const lower = message.toLowerCase();
    return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async waitForRetryDelay(
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = OPENCODE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private buildRateLimitedResponse(
    agentType: string,
    sessionId: string | undefined,
    message: string,
  ): AgentResponse {
    return {
      persona: agentType,
      timestamp: new Date(),
      sessionId,
      ...buildRateLimitedResponseFields('opencode', 'sdk_error', message),
    };
  }

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    // native format（StructuredOutput ツール）をモデルが呼ばない個体が
    // あるため、その失敗を検出したら format なし（手書き JSON + 下流の
    // 是正リトライ）へフォールバックする。劣化後は汚染されたセッションを
    // 引きずらないよう fresh session を強制する（structured-output-recovery.ts）。
    let recoveryState = createStructuredOutputRecoveryState(options.outputSchema !== undefined);
    // 幻覚ツール名（存在しない 'run' 等）の連続呼び出しで止まった場合の
    // 一般 recovery。structured-output 側とは病因が違うため予算も状態も独立
    // （unavailable-tool-recovery.ts）。
    let unavailableToolRecovery = createUnavailableToolRecoveryState();
    // tool ガード（進捗感知型 burst / edit conflict / 絶対コスト上限）。
    // call() 全体で1インスタンス: 絶対台帳は attempt / recovery をまたいで
    // 引き継ぎ、attempt 開始時に短期カウンタだけをリセットする。
    const toolGuard = new OpenCodeToolGuard();
    let toolGuardRecovery = createToolGuardRecoveryState();
    // call() の最初から resume を意図していたかどうか。attempt ごとに変わる
    // sessionId（劣化/救済で fresh に切り替わる）とは別に、呼び出し元の意図を
    // 固定値として持つ必要がある。
    const hasInitialSessionId = options.sessionId !== undefined;
    // フォールバック（format なし再試行 / stale session 救済 / unavailable-tool
    // 救済）は transient 再試行の予算とは別枠で、それぞれ1回だけ確保する:
    // 先行の transient エラーで予算を使い切っていても、最終試行の失敗から
    // 救済できるようにする。
    let maxAttempts = OPENCODE_RETRY_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs();
      const timeoutMessage = `OpenCode stream timed out after ${Math.round(streamIdleTimeoutMs / 60000)} minutes of inactivity`;
      let abortCause: OpenCodeAbortCause | undefined;
      let diagRef: StreamDiagnostics | undefined;
      let release: (() => void) | undefined;
      let opencodeApiClient: OpencodeClient | undefined;
      const structuredAttemptPlan = planStructuredOutputAttempt(recoveryState, hasInitialSessionId);
      // unavailable-tool recovery 後の attempt も fresh session を強制する。
      // plan の sessionMode を実態に合わせて上書きしておかないと、後段の
      // stale StructuredOutput 判定（plan.sessionMode === 'resume' が条件）が
      // 「fresh なのに resume 扱い」で誤発動し、救済の連鎖で attempt が増える。
      const attemptPlan = unavailableToolRecovery.used || toolGuardRecovery.freshSessionUsed
        ? { ...structuredAttemptPlan, sessionMode: 'fresh' as const }
        : structuredAttemptPlan;
      // edit conflict の correction attempt は直前の attempt のセッションを再開する
      // （同一セッション内で1回だけの是正指示 — tool-guard.ts 参照）。
      const pendingToolGuardCorrection = toolGuardRecovery.pendingCorrection;
      if (pendingToolGuardCorrection !== undefined) {
        toolGuardRecovery = clearToolGuardPendingCorrection(toolGuardRecovery);
      }
      let sessionId: string | undefined = pendingToolGuardCorrection !== undefined
        ? pendingToolGuardCorrection.sessionId
        : (attemptPlan.sessionMode === 'fresh' ? undefined : options.sessionId);
      let promptCompletion: Promise<unknown> | undefined;
      let promptCompletionWait: Promise<void> | undefined;
      let promptError: string | undefined;
      const interactionTimeoutMs = options.interactionTimeoutMs ?? OPENCODE_INTERACTION_TIMEOUT_MS;
      const promptCompletionTimeoutMessage = 'OpenCode prompt completion timed out';

      const awaitPromptCompletion = (): Promise<void> => {
        if (!promptCompletion) {
          return Promise.resolve();
        }

        promptCompletionWait ??= (async () => {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              promptCompletion,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  reject(new Error(promptCompletionTimeoutMessage));
                }, interactionTimeoutMs);
              }),
            ]);
          } catch (error) {
            promptError ??= getErrorMessage(error);
          } finally {
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
          }
        })();
        return promptCompletionWait;
      };

      const resetIdleTimeout = (): void => {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = setTimeout(() => {
          diagRef?.onIdleTimeoutFired();
          log.warn(timeoutMessage, { sessionId, model: options.model });
          abortCause = 'timeout';
          streamAbortController.abort();
        }, streamIdleTimeoutMs);
      };

      const onExternalAbort = (): void => {
        abortCause = 'external';
        streamAbortController.abort();
      };

      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          abortCause = 'external';
          streamAbortController.abort();
        } else {
          options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      try {
        log.debug('Starting OpenCode session', {
          agentType,
          model: options.model,
          hasSystemPrompt: !!options.systemPrompt,
          attempt,
        });

        const diag = createStreamDiagnostics('opencode-sdk', { agentType, model: options.model, attempt });
        diagRef = diag;

        const parsedModel = parseProviderModel(options.model, 'OpenCode model');
        const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;

        const acquired = await acquireClient(
          fullModel,
          options.opencodeApiKey,
          options.childProcessEnv,
          options.abortSignal,
        );
        opencodeApiClient = acquired.client;
        release = acquired.release;
        if (streamAbortController.signal.aborted) {
          release();
          release = undefined;
          throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
        }
        const permissionRuleset = buildOpenCodePermissionRuleset(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        // The session is created once per step and reused across phases: a
        // session-scoped deny can never be escalated later, and recreating the
        // session drops the conversation history the report/judgment phases
        // depend on. Per-phase tool restriction rides on the explicit prompt
        // tools map below instead.
        const appliedPermissionRuleset = sessionId === undefined;
        const sessionPermission = buildOpenCodeSessionPermission(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        if (sessionId === undefined) {
          const sessionResult = await opencodeApiClient.session.create({
            directory: options.cwd,
            permission: sessionPermission,
          });

          sessionId = sessionResult.data?.id;
          if (!sessionId) {
            throw new Error('Failed to create OpenCode session');
          }
        }

        const activeSessionId = sessionId;
        if (activeSessionId === undefined) {
          throw new Error('OpenCode session ID is required');
        }

        const { stream } = await opencodeApiClient.event.subscribe(
          { directory: options.cwd },
          { signal: streamAbortController.signal },
        );
        resetIdleTimeout();
        diag.onConnected();
        if (appliedPermissionRuleset) {
          emitPermissionSummary(options.onStream, {
            sessionId: activeSessionId,
            ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
            ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
            ...(options.networkAccess !== undefined ? { networkAccess: options.networkAccess } : {}),
            resolvedPermissions: sessionPermission,
          });
        }

        const agentName = selectTaktAgent(options.allowedTools);
        // OpenCode persists the last explicit tools map on the session, so
        // every prompt sends the full map for its own phase (see
        // buildOpenCodePromptTools).
        const promptTools = buildOpenCodePromptTools(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        log.debug('Selecting OpenCode agent', {
          agentName,
          allowedTools: options.allowedTools,
          promptTools,
        });
        // native format 劣化後の attempt は、structured_json_schema_instruction
        // でスキーマと fenced JSON 契約・StructuredOutput 禁止を明示したプロンプトへ
        // 包み直す。この attempt は session も fresh 強制済み（attemptPlan 参照）。
        const basePromptText = attemptPlan.structuredMode === 'formatless' && options.outputSchema !== undefined
          ? buildFormatlessStructuredPrompt(prompt, options.outputSchema)
          : prompt;
        // unavailable-tool recovery 後の attempt は、さらに再試行前置文
        // （幻覚ツール名の指摘・有効ツール一覧・workspace 継続の警告）で包む。
        // 有効ツール一覧は**サーバ申告**（エラー文の "Available tools: ..."）を
        // 正とし、取れない場合のみ promptTools（buildOpenCodePromptTools() の
        // 結果、ワイヤ専用 ID 除外済み）へフォールバックする。写像由来の一覧が
        // 実在しない 'list' を「利用可能」と再誘導した v3-r4 の再発防止。
        const unavailableWrappedPromptText = unavailableToolRecovery.used && unavailableToolRecovery.tool !== undefined
          ? buildUnavailableToolRetryPrompt(
              basePromptText,
              unavailableToolRecovery.tool,
              unavailableToolRecovery.serverAvailableTools,
            )
          : basePromptText;
        // tool-guard recovery の attempt:
        // - correction: 同一セッション再開なので元プロンプトは再送しない
        //   （セッションに文脈がある）。是正指示だけを送る。
        // - fresh session: unavailable-tool recovery と同じ機構で、workspace の
        //   途中成果・上書き禁止・再読込を明記した前置文で元プロンプトを包む。
        const promptText = pendingToolGuardCorrection !== undefined
          ? buildEditConflictCorrectionPrompt(pendingToolGuardCorrection.filePath)
          : toolGuardRecovery.freshSessionUsed && toolGuardRecovery.freshReason !== undefined
            ? buildToolGuardRetryPrompt(unavailableWrappedPromptText, toolGuardRecovery.freshReason)
            : unavailableWrappedPromptText;
        const promptPayload: Record<string, unknown> = {
          sessionID: activeSessionId,
          directory: options.cwd,
          model: parsedModel,
          tools: promptTools,
          ...(agentName !== undefined ? { agent: agentName } : {}),
          ...(options.variant !== undefined ? { variant: options.variant } : {}),
          ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
          // ネイティブ構造化出力: OpenCode がスキーマのキー構造を強制する
          // （enum 等の値制約までは保証されないため、下流のスキーマ検証は維持）。
          ...(attemptPlan.structuredMode === 'native' && options.outputSchema !== undefined
            ? { format: { type: 'json_schema' as const, schema: options.outputSchema, retryCount: 2 } }
            : {}),
          parts: [{ type: 'text' as const, text: promptText }],
        };
        const promptPayloadForSdk = promptPayload as unknown as Parameters<typeof opencodeApiClient.session.promptAsync>[0];
        promptCompletion = opencodeApiClient.session.promptAsync(promptPayloadForSdk, {
          signal: streamAbortController.signal,
        }).catch((error) => {
          promptError = getErrorMessage(error);
          if (!streamAbortController.signal.aborted) {
            abortCause = 'prompt';
            streamAbortController.abort();
          }
        });

        emitInit(options.onStream, options.model, activeSessionId);

        let content = '';
        let success = true;
        let capturedStructuredOutput: Record<string, unknown> | undefined;
        let failureMessage = '';
        // UnavailableToolLoopDetector が閾値到達で発火した際に、その呼び出しが
        // 狙っていたツール名を残す。stale StructuredOutput recovery の対象判定
        // （呼ばれたツールが正確に StructuredOutput か）と、一般 unavailable-tool
        // recovery の対象判定（StructuredOutput 以外か）の両方に使う。
        let unavailableLoopToolName: string | undefined;
        let unavailableLoopServerTools: readonly string[] | undefined;
        const state = createStreamTrackingState();
        // 新しい attempt = 新しいストリーム。セッション固有の短期カウンタだけ
        // リセットする（絶対台帳は call 全体で引き継ぐ — tool-guard.ts 参照）。
        toolGuard.resetSessionCounters();
        let toolGuardFailure: ToolGuardFailure | undefined;
        const echoState = { remainingPrompts: buildPromptEchoCandidates(promptText, options.systemPrompt) };
        const textOffsets = new Map<string, number>();
        const textContentParts = new Map<string, string>();

        // Consume a raw text delta for a part: strip the prompt echo, stream the
        // visible portion, accumulate it, and advance the part's raw offset in
        // lockstep. Sharing this keeps content and offset consistent whether the
        // text arrives via `message.part.delta` or a full-snapshot
        // `message.part.updated` — some providers emit both for the same part.
        const consumeTextDelta = (partId: string, rawDelta: string): void => {
          if (!rawDelta) return;
          const visibleDelta = stripPromptEcho(rawDelta, echoState);
          if (visibleDelta) {
            emitText(options.onStream, visibleDelta);
            const previous = textContentParts.get(partId) ?? '';
            textContentParts.set(partId, `${previous}${visibleDelta}`);
          }
          const prevOffset = textOffsets.get(partId) ?? 0;
          textOffsets.set(partId, prevOffset + rawDelta.length);
        };

        // for-await 単体だと、タイマーが abort してもイベントが来るまで
        // 待ちから戻らない（SDK が signal を尊重しない場合は永久待機）。
        // イテレータと abort をレースさせ、タイマー発火で必ず脱出する。
        const streamIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        const streamAborted = new Promise<never>((_, reject) => {
          streamAbortController.signal.addEventListener('abort', () => {
            reject(new Error(timeoutMessage));
          }, { once: true });
        });
        streamAborted.catch(() => { /* race の敗者側での未処理拒否を防ぐ */ });

        // 劣化した生成は「ごく短いアシスタント応答サイクル」を数百回繰り返す
        // （実測: 524〜1211 ループ）。テキスト断片だけの空転はツールエラー
        // 予算にも無音検出にも掛からないため、応答サイクル数で打ち切る。
        //
        // 数えるのは「ツール呼び出しが1つも成功しないまま続いたサイクル」に限る。
        // 総サイクル数で打ち切ると、健全な作業まで巻き込む（実測: 9万行の
        // リポジトリで implement が 120 サイクル・ツール成功 150 回の途中で
        // 打ち切られた）。
        //
        // OpenCode が拒否した呼び出し（`invalid` 擬似ツール）は status='completed'
        // で返るため、素直に completed でリセットすると空転もリセットされる。
        // extractOpenCodeToolRejection() で拒否を先に切り分けてから数える。
        let cyclesWithoutToolSuccess = 0;
        const messageCycleBudget = resolveMessageCycleBudget();

        try {
        while (true) {
          if (streamAbortController.signal.aborted) break;
          let iteration: IteratorResult<unknown>;
          try {
            iteration = await Promise.race([streamIterator.next(), streamAborted]);
          } catch (raceError) {
            if (streamAbortController.signal.aborted) break;
            throw raceError;
          }
          if (iteration.done) break;
          const event = iteration.value;

          const sseEvent = event as OpenCodeStreamEvent;
          // セッション帰属が判明していて自分でないイベントは処理しない。
          // サーバプールは同一モデルで共有されるため（並列レビュー等）、
          // 兄弟セッションの text/tool 更新を通すと content と検出器が
          // 汚染される。帰属不明のイベントは種別ごとの処理に委ねるが、
          // 無音検出のリセット（延命）は自セッションのイベントに限る。
          const eventSessionId = extractEventSessionId(sseEvent);
          if (eventSessionId !== undefined && eventSessionId !== activeSessionId) {
            continue;
          }
          if (eventSessionId === activeSessionId) {
            resetIdleTimeout();
          }
          diag.onFirstEvent(sseEvent.type);
          diag.onEvent(sseEvent.type);
          if (sseEvent.type === 'message.part.updated') {
            const props = sseEvent.properties as { part: OpenCodePart; delta?: string };
            const part = props.part;
            const delta = props.delta;

            if (part.type === 'text') {
              toolGuard.noteTextActivity();
              const textPart = part as OpenCodeTextPart;
              const prev = textOffsets.get(textPart.id) ?? 0;
              const rawDelta = delta
                ?? (textPart.text.length > prev ? textPart.text.slice(prev) : '');
              consumeTextDelta(textPart.id, rawDelta);
              continue;
            }

            if (part.type === 'tool') {
              const toolPart = part as OpenCodeToolPart;
              const rejection = extractOpenCodeToolRejection(toolPart);
              let loopError: string | undefined;
              // onStream（→ provider event logging 有効時は *-provider-events.jsonl
              // へ永続化される）にも raw エラー文を流さない。マスク済みの
              // コピーを downstream へ渡す（codex 裁定: onStream はライブ表示
              // 専用ではなく永続化経路を含む）。
              let partForDownstream: OpenCodePart = part;
              if (rejection !== undefined) {
                // 失敗したツール呼び出しの引数を残す。エラー文だけでは
                // モデルが何をどう間違えたか（スキーマ違反の該当欄、
                // 幻覚パス、oldString の不一致）を後から特定できない。
                // input/error は無加工では機密情報が残り得るためマスクする。
                // エラー文は先に edit 本文（oldString/newString の実値の引用）を
                // 除去し、以後 downstream にはマスク済みの文字列だけを流す。
                const maskedError = maskEditContentInErrorText(rejection.error, toolPart.state.input);
                if (toolPart.state.status === 'error') {
                  partForDownstream = {
                    ...toolPart,
                    state: { ...toolPart.state, error: maskedError },
                  } as OpenCodePart;
                }
                log.debug('OpenCode tool call failed', {
                  tool: rejection.tool,
                  callId: toolPart.callID || toolPart.id,
                  error: sanitizeSensitiveText(maskedError),
                  input: sanitizeToolCallInputForLogging(toolPart.state.input),
                });
                // ガードに観測させる（unavailable / invalid-argument の連続性
                // 検出器はガード内部で従来ロジックのまま動く）。発火は型付き
                // union（ToolGuardFailure）で受け取り、文字列を再パースしない。
                const failure = toolGuard.observeError(
                  toolPart.callID || toolPart.id,
                  rejection.tool,
                  maskedError,
                  toolPart.state.input,
                );
                if (failure !== undefined) {
                  if (failure.kind === 'unavailable_tool_loop') {
                    unavailableLoopToolName = failure.tool;
                    // サーバのエラー文が申告する利用可能一覧を実測として保持する。
                    // recovery 前置文はこれを正とする（TAKT の写像には旧バージョン
                    // 互換のワイヤ専用 ID が含まれ、v3-r4 で 'list' を誤誘導した）。
                    unavailableLoopServerTools = parseServerAvailableTools(failure.message);
                  }
                  toolGuardFailure = failure;
                  loopError = failure.message;
                }
              } else if (toolPart.state.status === 'completed') {
                // 進捗は2段階（強: write/edit/bash → 短期カウンタリセット、
                // 弱: read/glob/grep 等 → 密度緩和のみ — tool-guard.ts 参照）。
                toolGuard.observeSuccess(toolPart.callID || toolPart.id, toolPart.tool);
                // ツールが1つでも成功したなら作業は前に進んでいる。
                // 空転の計数をここで戻す（下の cyclesWithoutToolSuccess を参照）。
                cyclesWithoutToolSuccess = 0;
              }
              handlePartUpdated(partForDownstream, delta, options.onStream, state);
              if (loopError !== undefined) {
                success = false;
                failureMessage = loopError;
                diag.onStreamError('message.part.updated', loopError);
                break;
              }
              continue;
            }

            handlePartUpdated(part, delta, options.onStream, state);
            continue;
          }

          if (sseEvent.type === 'message.part.delta') {
            const deltaProps = sseEvent.properties as {
              sessionID: string;
              partID: string;
              field: string;
              delta: string;
            };
            if (deltaProps.field === 'text' && deltaProps.delta) {
              toolGuard.noteTextActivity();
              consumeTextDelta(deltaProps.partID, deltaProps.delta);
            }
            continue;
          }

          if (sseEvent.type === 'permission.asked') {
            const permProps = sseEvent.properties as {
              id: string;
              sessionID: string;
              permission?: string;
              patterns?: string[];
              always?: string[];
            };
            if (permProps.sessionID === activeSessionId) {
              try {
                const reply = resolveOpenCodePermissionReply(
                  options.permissionMode,
                  permProps.permission,
                  options.allowedTools !== undefined ? permissionRuleset : undefined,
                );
                emitPermissionAsked(options.onStream, {
                  requestId: permProps.id,
                  sessionId: permProps.sessionID,
                  permission: permProps.permission ?? '',
                  patterns: Array.isArray(permProps.patterns) ? permProps.patterns : [],
                  always: Array.isArray(permProps.always) ? permProps.always : [],
                  reply,
                });
                await withTimeout(
                  (signal) => opencodeApiClient!.permission.reply({
                    requestID: permProps.id,
                    directory: options.cwd,
                    reply,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode permission reply timed out',
                );
                if (reply === 'reject') {
                  // A rejected permission is a per-tool failure, not a fatal
                  // one: OpenCode returns the rejection to the model as a tool
                  // error and generation continues (verified against a live
                  // server). Aborting here used to turn a single stray
                  // out-of-workspace access into a whole-step failure.
                  log.info(buildPermissionRejectedMessage(permProps.permission), {
                    permission: permProps.permission,
                    patterns: permProps.patterns,
                  });
                }
              } catch (e) {
                success = false;
                failureMessage = getErrorMessage(e);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'question.asked') {
            const questionProps = sseEvent.properties as OpenCodeQuestionAskedProperties;
            if (questionProps.sessionID === activeSessionId) {
              const rejectQuestion = (): Promise<unknown> =>
                withTimeout(
                  (signal) => opencodeApiClient!.question.reject({
                    requestID: questionProps.id,
                    directory: options.cwd,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reject timed out',
                );

              if (!options.onAskUserQuestion) {
                try {
                  await rejectQuestion();
                } catch (e) {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
                continue;
              }

              try {
                const answers = await options.onAskUserQuestion(toQuestionInput(questionProps));
                await withTimeout(
                  (signal) => opencodeApiClient!.question.reply({
                    requestID: questionProps.id,
                    directory: options.cwd,
                    answers: toQuestionAnswers(questionProps, answers),
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reply timed out',
                );
              } catch (e) {
                if (e instanceof AskUserQuestionDeniedError) {
                  try {
                    await rejectQuestion();
                  } catch (rejectErr) {
                    success = false;
                    failureMessage = getErrorMessage(rejectErr);
                    break;
                  }
                } else {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.updated') {
            const messageProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                time?: { completed?: number };
                error?: unknown;
                structured?: unknown;
              };
            };
            const info = messageProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              if (info?.structured !== undefined && info.structured !== null && typeof info.structured === 'object' && !Array.isArray(info.structured)) {
                capturedStructuredOutput = info.structured as Record<string, unknown>;
              }
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.updated', streamError);
                break;
              }
              if (info?.time?.completed !== undefined) {
                cyclesWithoutToolSuccess += 1;
                if (cyclesWithoutToolSuccess >= messageCycleBudget) {
                  success = false;
                  failureMessage = `OpenCode assistant message cycle budget exceeded (${cyclesWithoutToolSuccess} cycles without a successful tool call)`;
                  diag.onStreamError('message.updated', failureMessage);
                  break;
                }
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.completed') {
            const completedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
                structured?: unknown;
              };
            };
            const info = completedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              if (info?.structured !== undefined && info.structured !== null && typeof info.structured === 'object' && !Array.isArray(info.structured)) {
                capturedStructuredOutput = info.structured as Record<string, unknown>;
              }
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.completed', streamError);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.failed') {
            const failedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
              };
            };
            const info = failedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(info?.error) ?? 'OpenCode message failed';
              diag.onStreamError('message.failed', failureMessage);
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.status') {
            const statusProps = sseEvent.properties as {
              sessionID?: string;
              status?: { type?: string };
            };
            if (statusProps.sessionID === activeSessionId && statusProps.status?.type === 'idle') {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.idle') {
            const idleProps = sseEvent.properties as { sessionID: string };
            if (idleProps.sessionID === activeSessionId) {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.error') {
            const errorProps = sseEvent.properties as {
              sessionID?: string;
              error?: unknown;
            };
            if (!errorProps.sessionID || errorProps.sessionID === activeSessionId) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(errorProps.error) ?? 'OpenCode session error';
              diag.onStreamError('session.error', failureMessage);
              break;
            }
            continue;
          }
        }
        } finally {
          // for-await が break 時に行っていた後始末（SSE クローズ）を再現する
          try {
            await streamIterator.return?.(undefined);
          } catch { /* クローズ失敗は結果に影響させない */ }
        }

        // The idle watchdog and external aborts cancel the stream. If the
        // iterator ends without throwing, the loop falls through with
        // success still true - do not let a timed-out or aborted stream
        // pass as a completed call (a stalled stream after a rejected
        // permission would otherwise be reported as done).
        if (success && streamAbortController.signal.aborted && (abortCause === 'timeout' || abortCause === 'external')) {
          success = false;
          failureMessage = abortCause === 'timeout' ? timeoutMessage : OPENCODE_STREAM_ABORTED_MESSAGE;
        }

        content = [...textContentParts.values()].join('\n');
        if (!success && !streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        if (promptError !== undefined) {
          if (success) {
            success = false;
            failureMessage = promptError;
          } else if (!failureMessage) {
            failureMessage = promptError;
          }
        }
        diag.onCompleted(success ? 'normal' : 'error', success ? undefined : failureMessage);

        if (!success) {
          const message = failureMessage || 'OpenCode execution failed';
          // 無音タイムアウトで止めた場合、死因はサーバが握った 429 かもしれない。
          // メッセージ文字列だけでは判別できないため、セッションを検死する。
          if (
            abortCause === 'timeout'
            && !containsRateLimitError(message)
            && opencodeApiClient !== undefined
            && activeSessionId !== undefined
          ) {
            const rateLimitMessage = await postmortemRateLimitError(
              opencodeApiClient,
              activeSessionId,
              options.cwd,
            );
            if (rateLimitMessage !== undefined) {
              // プロバイダ由来の生エラー文はリクエスト内容やアカウント情報を
              // 含みうるため、分類済みの事実だけを永続化する。
              log.warn('OpenCode stream stalled on a provider rate limit', {
                sessionId: activeSessionId,
                model: options.model,
              });
              // 検死で 429 と確定済み。message 文字列に 429 の語が含まれるとは
              // 限らない（statusCode だけで判定した場合）ため再判定はしない。
              const rateLimitedResponse = this.buildRateLimitedResponse(agentType, activeSessionId, rateLimitMessage);
              emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
              return rateLimitedResponse;
            }
          }
          if (containsRateLimitError(message)) {
            const rateLimitedResponse = this.buildRateLimitedResponse(agentType, activeSessionId, message);
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
            return rateLimitedResponse;
          }
          // Failures that point at the native json_schema request itself: a
          // model that never emits the StructuredOutput tool ("did not produce
          // structured output"), or a gateway/model that rejects the json_schema
          // response format outright (surfaced as an upstream request error).
          // These fall back to formatless structured output in a fresh session —
          // resuming the same session would let the model keep "remembering" the
          // native tool it just failed to use. Generic transient errors
          // (transport/network) must not trigger this, or they would burn the
          // one-shot fallback budget before a real format failure arrives.
          if (shouldDegradeToFormatless(recoveryState, message)) {
            recoveryState = degradeToFormatless(recoveryState);
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.debug('OpenCode native structured output failed; degrading to formatless prompt in a fresh session', {
              agentType,
              previousAttempt: attempt,
              previousSessionId: activeSessionId,
              message,
            });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          // A resumed session can carry native StructuredOutput success history
          // from an earlier (unrelated) step. When this attempt does not request
          // structured output at all (plain) but the model still calls the now-
          // unavailable StructuredOutput tool until the loop detector fires,
          // that is stale session memory, not a real failure of this request —
          // retry the same prompt once in a fresh session instead of failing
          // the step outright.
          if (shouldRecoverStaleSession(recoveryState, attemptPlan, unavailableLoopToolName)) {
            recoveryState = recoverStaleSession(recoveryState);
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.debug('OpenCode resumed session called a stale StructuredOutput tool; retrying prompt in a fresh session', {
              agentType,
              previousAttempt: attempt,
              previousSessionId: activeSessionId,
              tool: unavailableLoopToolName,
            });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          // A general unavailable-tool loop: the model kept calling a tool name
          // that does not exist (hallucinated 'run' etc.) until the detector's
          // threshold of 2 fired. Retry the same prompt once in a fresh session
          // with a retry preamble (hallucinated name, valid tool list, workspace
          // continuation warning). StructuredOutput is deliberately excluded —
          // its only rescue path is the stricter stale-session branch above.
          if (
            unavailableLoopToolName !== undefined
            && shouldRecoverUnavailableToolLoop(unavailableToolRecovery, unavailableLoopToolName)
          ) {
            unavailableToolRecovery = markUnavailableToolRecoveryUsed(
              unavailableToolRecovery,
              unavailableLoopToolName,
              unavailableLoopServerTools,
            );
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.debug('OpenCode unavailable tool loop detected; retrying prompt once in a fresh session with a retry preamble', {
              agentType,
              previousAttempt: attempt,
              previousSessionId: activeSessionId,
              tool: unavailableLoopToolName,
            });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          // edit_conflict_loop: 同一セッション内 correction（対象再読込・同一
          // oldString 反復禁止・必要なら write、の是正指示）。署名を照合する:
          // correction 済み署名の再発は「correction 失敗」として下の fresh へ
          // escalate し、別署名の新規 conflict は自身の correction 段階から
          // 始める（コール全体の correction 回数上限内で）。
          if (
            toolGuardFailure?.kind === 'edit_conflict_loop'
            && shouldIssueEditConflictCorrection(toolGuardRecovery, toolGuardFailure.signature)
            && activeSessionId !== undefined
          ) {
            toolGuardRecovery = markToolGuardCorrectionPending(
              toolGuardRecovery,
              activeSessionId,
              toolGuardFailure.filePath,
              toolGuardFailure.signature,
            );
            toolGuard.noteRecovery();
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.debug('OpenCode edit conflict loop detected; sending one in-session correction', {
              agentType,
              previousAttempt: attempt,
              sessionId: activeSessionId,
              signature: toolGuardFailure.signature.slice(0, 12),
              toolHealth: toolGuard.stats(),
            });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          // correction 済み署名の再発（correction 失敗）・correction 上限超過後の
          // 新規 conflict・tool_error_burst: fresh session recovery を最大1回
          //（すべてで合計1回を共有）。
          if (
            (toolGuardFailure?.kind === 'edit_conflict_loop' || toolGuardFailure?.kind === 'tool_error_burst')
            && !toolGuardRecovery.freshSessionUsed
          ) {
            toolGuardRecovery = markToolGuardFreshSessionUsed(toolGuardRecovery, toolGuardFailure.kind);
            toolGuard.noteRecovery();
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.debug('OpenCode tool guard failure; retrying prompt once in a fresh session with a continuation preamble', {
              agentType,
              previousAttempt: attempt,
              previousSessionId: activeSessionId,
              reason: toolGuardFailure.kind,
              toolHealth: toolGuard.stats(),
            });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          // ガード発火（absolute_cost_limit / recovery 消費後の再発）は決定的な
          // ループ失敗であり transient ではない — retriable 判定に流さず即失敗する。
          // needs_fix / plan への自動迂回はしない（インフラ障害とレビュー判断を
          // 混同しない — codex 裁定）。
          const retriable = toolGuardFailure === undefined
            && this.isRetriableError(message, streamAbortController.signal.aborted, abortCause);
          if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
            log.info('Retrying OpenCode call after transient failure', { agentType, attempt, message });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          if (recoveryState.nativeDegraded || recoveryState.staleSessionRecoveryUsed || unavailableToolRecovery.used) {
            log.debug('OpenCode recovery attempt finished', {
              agentType,
              attempt,
              sessionId: activeSessionId,
              nativeDegraded: recoveryState.nativeDegraded,
              staleSessionRecoveryUsed: recoveryState.staleSessionRecoveryUsed,
              unavailableToolRecoveryUsed: unavailableToolRecovery.used,
              outcome: 'error',
              message,
            });
          }

          emitResult(options.onStream, false, message, activeSessionId);
          // 観測: 閾値校正の材料として tool health を構造化して残す
          // （debug ログ + AgentResponse.debugInfo）。
          const failureToolHealth = toolGuard.stats();
          log.debug('OpenCode tool health at failure', { agentType, ...failureToolHealth });
          return {
            persona: agentType,
            status: 'error',
            content: message,
            error: message,
            timestamp: new Date(),
            sessionId: activeSessionId,
            debugInfo: { toolHealth: failureToolHealth },
          };
        }

        if (recoveryState.nativeDegraded || recoveryState.staleSessionRecoveryUsed || unavailableToolRecovery.used) {
          log.debug('OpenCode recovery attempt finished', {
            agentType,
            attempt,
            sessionId: activeSessionId,
            nativeDegraded: recoveryState.nativeDegraded,
            staleSessionRecoveryUsed: recoveryState.staleSessionRecoveryUsed,
            unavailableToolRecoveryUsed: unavailableToolRecovery.used,
            outcome: 'success',
          });
        }

        const trimmed = content.trim();
        emitResult(options.onStream, true, trimmed, activeSessionId);

        // format 要求時に structured がイベントで捕捉できなかった場合は、
        // 本文の末尾 JSON をフォールバックとして採取する（検証は下流で行う）。
        if (capturedStructuredOutput === undefined && options.outputSchema !== undefined) {
          try {
            const parsed = parseLastJsonBlock(trimmed);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              capturedStructuredOutput = parsed as Record<string, unknown>;
            } else {
              log.debug('Structured output fallback found non-object JSON', { agentType });
            }
          } catch (fallbackError) {
            // フォールバック採取の失敗は握りつぶすが、調査用に痕跡は残す
            // （下流の検証と是正リトライに委ねる）。
            log.debug('Structured output fallback extraction failed', {
              agentType,
              error: getErrorMessage(fallbackError),
            });
          }
        }

        // 観測: 成功時も tool health を残す（v3-r4 のような「生産的だが edit 税を
        // 払っている」走行の分布を校正データとして採取するため）。
        const successToolHealth = toolGuard.stats();
        if (successToolHealth.totalErrors > 0) {
          log.debug('OpenCode tool health at success', { agentType, ...successToolHealth });
        }
        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId: activeSessionId,
          ...(capturedStructuredOutput !== undefined ? { structuredOutput: capturedStructuredOutput } : {}),
          debugInfo: { toolHealth: successToolHealth },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : abortCause === 'prompt' && promptError !== undefined
              ? promptError
              : OPENCODE_STREAM_ABORTED_MESSAGE
          : message;

        if (containsRateLimitError(errorMessage)) {
          const rateLimitedResponse = this.buildRateLimitedResponse(agentType, sessionId, errorMessage);
          if (sessionId) {
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, sessionId);
          }
          return rateLimitedResponse;
        }

        diagRef?.onCompleted(
          abortCause === 'timeout' ? 'timeout' : streamAbortController.signal.aborted && abortCause !== 'prompt' ? 'abort' : 'error',
          errorMessage,
        );

        const retriable = this.isRetriableError(errorMessage, streamAbortController.signal.aborted, abortCause);
        if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
          log.info('Retrying OpenCode call after transient exception', { agentType, attempt, errorMessage });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          continue;
        }

        if (sessionId) {
          emitResult(options.onStream, false, errorMessage, sessionId);
        }

        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          error: errorMessage,
          timestamp: new Date(),
          sessionId,
        };
      } finally {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onExternalAbort);
        }
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        release?.();
      }
    }

    throw new Error('Unreachable: OpenCode retry loop exhausted without returning');
  }

  async compactSession(options: OpenCodeCompactSessionOptions): Promise<void> {
    const parsedModel = parseProviderModel(options.model, 'OpenCode model');
    const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;
    const acquired = await acquireClient(
      fullModel,
      options.opencodeApiKey,
      options.childProcessEnv,
      options.abortSignal,
    );

    try {
      const existingSummaryIds = await collectExistingSummaryIds(
        acquired.client,
        options.sessionId,
        options.cwd,
        options.abortSignal,
      );

      await withTimeout(
        (signal) => acquired.client.session.summarize({
          sessionID: options.sessionId,
          directory: options.cwd,
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          auto: false,
        }, { signal }),
        OPENCODE_INTERACTION_TIMEOUT_MS,
        'OpenCode session summarize timed out',
        options.abortSignal,
      );

      // summarize は要約ジョブを投入して即座に返る。要約中のセッションは
      // ツール呼び出しを "Tool call not allowed while generating summary" で
      // 拒否するため、完了を待たずに次のプロンプトを送ると最初の edit で落ちる。
      await waitForSummaryToComplete(
        acquired.client,
        options.sessionId,
        options.cwd,
        existingSummaryIds,
        options.abortSignal,
      );
    } finally {
      acquired.release();
    }
  }

  /** Call OpenCode with a custom agent configuration (system prompt + prompt) */
  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new OpenCodeClient();

export async function callOpenCode(
  agentType: string,
  prompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callOpenCodeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}

export async function compactOpenCodeSession(options: OpenCodeCompactSessionOptions): Promise<void> {
  return defaultClient.compactSession(options);
}
