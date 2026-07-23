import { hasRejectedFinding } from './boundary-clean-output.mjs';
import { hasAffirmativeEvidenceLine } from './boundary-positive-evidence.mjs';

export default function assertBoundaryRobustnessClean(output) {
  const confirms = (citation, required) => hasAffirmativeEvidenceLine(output, {
    citation,
    required,
  });

  return confirms(
    /src\/import-document\.ts:(?:12|14)\b/,
    [
      /(?:catch|捕捉)/i,
      /(?:isolat(?:es|ed)|continue|隔離|継続)/i,
    ],
  )
    && confirms(
      /src\/import-document\.ts:15\b/,
      [
        /(?:warning|警告)/i,
        /(?:reported|visible|報告|可視)/i,
      ],
    )
    && confirms(
      /src\/import-document\.ts:19\b/,
      [
        /(?:body|primary result|本文|主結果)/i,
        /(?:preserv(?:es|ed)|retain(?:s|ed)|return(?:s|ed)|維持|保持|返される)/i,
      ],
    )
    && !hasRejectedFinding(output);
}
