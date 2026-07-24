import { hasRejectedFinding } from './boundary-clean-output.mjs';
import { hasAffirmativeEvidenceLine } from './boundary-positive-evidence.mjs';

export default function assertBoundaryResourceClean(output) {
  const confirmsReleasePath = (citation) => hasAffirmativeEvidenceLine(output, {
    citation,
    required: [
      /(?:finally|releasePreviews|\brelease\b|cleanup|解放|後始末)/i,
      /(?:success|failure|every exit|all paths|always|成功|失敗|全経路|全ての経路|必ず)/i,
    ],
  });

  return confirmsReleasePath(/src\/cli-import\.ts:(?:17|18)\b/)
    && confirmsReleasePath(/src\/system-enqueue\.ts:(?:17|18)\b/)
    && confirmsReleasePath(/src\/interactive-import\.ts:(?:20|21)\b/)
    && !hasRejectedFinding(output);
}
