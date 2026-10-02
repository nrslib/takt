import assertTextOnlyReplay from './interactive-topic-replay.mjs';
import { hasContinuationTaskIdentity } from './interactive-topic-identity.mjs';

const lineNumber = /行番号|\bline\s*(?:number|no\.?|\d+)/iu;
const errorCause = /原因|理由|\bcause\b|\breason\b/iu;
const unsupportedInspection = /(?:ファイル|リポジトリ|コードベース).{0,30}(?:見つかりませんでした|検索しても|確認したところ)|(?:見つかりませんでした|検索しても).{0,30}(?:ファイル|リポジトリ|コードベース)|\bI\s+(?:searched|inspected|checked)\s+(?:the\s+)?(?:repository|codebase|files?)\b|\b(?:file|repository)\s+(?:was\s+)?not\s+found\b/iu;

export default function assertContinuation(output) {
  const trimmed = output.trim();
  const hasQuestion = /[?？]/u.test(trimmed);
  const hasSummary = lineNumber.test(trimmed) && errorCause.test(trimmed);
  const pass = hasContinuationTaskIdentity(trimmed)
    && (hasQuestion || hasSummary)
    && !unsupportedInspection.test(trimmed)
    && assertTextOnlyReplay(trimmed).pass;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? 'Current-task question or requirement summary without invented inspection'
      : 'Expected a current-task question or requirement summary without simulated tools or invented inspection',
  };
}
