export interface CompanionDiff {
  readonly digest: string;
  readonly changedLines: number;
  readonly content: string;
  readonly changedFiles: readonly string[];
  readonly fileFingerprints: Readonly<Record<string, string>>;
  readonly hunkFingerprints: Readonly<Record<string, string>>;
  readonly omittedBytes: number;
  readonly truncated: boolean;
}

export type CompanionDiffReadFailureCode =
  | 'aborted'
  | 'blob_limit'
  | 'file_count_limit'
  | 'git_failure'
  | 'input_limit'
  | 'process_limit'
  | 'stderr_limit'
  | 'stdout_limit'
  | 'temporary_storage_limit'
  | 'timeout';

export type CompanionDiffReadResult =
  | { readonly status: 'ok'; readonly snapshot: CompanionDiff }
  | {
      readonly status: 'error';
      readonly failure: {
        readonly code: CompanionDiffReadFailureCode;
        readonly message: string;
      };
    };

export interface CompanionDiffReader {
  readBaselineSha(cwd: string, signal?: AbortSignal): Promise<string>;
  readDiff(cwd: string, baselineSha: string, signal?: AbortSignal): Promise<CompanionDiffReadResult>;
}
