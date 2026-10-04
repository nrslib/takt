export type RunResult =
  | { status: 'completed'; reportPath: string }
  | { status: 'failed'; error: Error }
  | { status: 'cancelled'; reason: string };
