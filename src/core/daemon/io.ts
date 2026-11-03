import type { ManagedProcess } from '../../shared/utils/spawn.js';

/** A/C/D/E が指定し、B のロック・コマンド・プロセス照会が必ず尊重する。 */
export interface IoOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** B が実装、C/D が利用。Promise 完了まで保持し、解放失敗も reject する。 */
export interface AsyncLock {
  // 複数取得は project goal-execution → goal → tasks。共有 Git は共通 directory/ref 単位。
  exclusive<T>(path: string, action: () => Promise<T>, options: IoOptions): Promise<T>;
}

/** C/E が作り、B が shell を介さず非同期起動する。 */
export interface CommandRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  maxOutputBytes: number;
}

/** B が終了確認後に返し、C/E が終了理由と出力省略を区別する。 */
export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
}

/** B が実装し、C/E が git・gh・ps を実行する。取消・期限は子の終了確認後に reject する。 */
export interface CommandPort {
  run(request: CommandRequest, options: IoOptions): Promise<CommandResult>;
}

/** B/C が保存し、E が PID の再利用を識別する。 */
export interface ProcessOwner {
  pid: number;
  startTime: string;
}

/** B が観測し、E が unknown と dead を区別する。 */
export type ProcessObservation =
  | { kind: 'alive'; owner: ProcessOwner }
  | { kind: 'dead' }
  | { kind: 'unknown'; reason: string };

/** B が起動後に作り、C が owner を保存し、A が process の終了を確認する。 */
export interface LaunchedProcess {
  owner: ProcessOwner;
  process: ManagedProcess;
}

/** B が実装し、C が run 起動、E が生死照会に使う。launch の期限は起動まで、signal は子の寿命に適用する。 */
export interface ProcessPort {
  inspect(owner: ProcessOwner, options: IoOptions): Promise<ProcessObservation>;
  launch(request: CommandRequest, options: IoOptions): Promise<LaunchedProcess>;
}
