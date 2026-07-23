import { hasRejectedFinding } from './boundary-clean-output.mjs';
import { hasAffirmativeEvidenceLine } from './boundary-positive-evidence.mjs';

export default function assertBoundaryContractClean(output) {
  const confirmsPreviewPath = (citation) => hasAffirmativeEvidenceLine(output, {
    citation,
    required: [
      /(?:document\.previews|\bpreviews?\b|プレビュー)/i,
      /(?:store\.save|\b(?:pass(?:es|ed)?|preserv(?:es|ed)|persist(?:s|ed)?|sav(?:e|es|ed)|forward(?:s|ed)?|propagat(?:es|ed)?)\b|引き渡|維持|保持|保存|伝播)/i,
    ],
  });

  return confirmsPreviewPath(/src\/cli-import\.ts:14\b/)
    && confirmsPreviewPath(/src\/system-enqueue\.ts:14\b/)
    && confirmsPreviewPath(/src\/interactive-import\.ts:17\b/)
    && !hasRejectedFinding(output);
}
