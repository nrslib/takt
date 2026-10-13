import { runGoalGit } from './git-command.js';

export const GOAL_DIFF_MAX_FILES = 50;
const GOAL_DIFF_MAX_BYTES = 4096;

export function parseGoalNumstat(output: Buffer, limit: number, truncated: boolean) {
  const fields = output.toString('utf8').split('\0');
  fields.pop();
  const files = fields.map((record) => {
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw new Error('Invalid Git numstat record');
    const additions = record.slice(0, first);
    const deletions = record.slice(first + 1, second);
    return {
      path: record.slice(second + 1),
      additions: additions === '-' ? null : Number(additions),
      deletions: deletions === '-' ? null : Number(deletions),
    };
  });
  return {
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    files: files.slice(0, limit),
    truncated: truncated || files.length > limit,
    totalsTruncated: truncated,
  };
}

export async function readGoalDiffSummary(
  cwd: string, comparisonSha: string, sourceSha: string, limit: number, signal: AbortSignal | undefined,
) {
  const stat = await runGoalGit(cwd, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', `${comparisonSha}...${sourceSha}`, '--numstat', '-z',
  ], GOAL_DIFF_MAX_BYTES, signal);
  return parseGoalNumstat(stat.output, limit, stat.truncated);
}
