import { hasFindingLine } from './boundary-finding-line.mjs';

const DESTINATION_ACQUISITION = /chooseDestination/i;
const CLEANUP_BOUNDARY = /(?:\b(?:try|finally|cleanup|release(?:Previews|\s+scope)?)\b|解放|後始末)/i;
const ACQUISITION_OUTSIDE_BOUNDARY = /(?:\b(?:before|outside|precedes?|prior to)\b|範囲外|より前|前に)/i;
const MISSED_RELEASE = /(?:\bleak(?:s|ed)?\b|\bunreleased\b|\b(?:releasePreviews|release|cleanup)\b[^.;。|]*\bnever\s+runs?\b|\b(?:releasePreviews|release|cleanup)\b[^.;。|]*(?:skipped|bypassed)|未解放|解放されない|後始末されない|漏れる)/i;
const ACTIONABLE_FIX = /(?:\b(?:move|place|include|wrap|extend)\b|移す|移動|含め|囲む|広げ)/i;

const REFUTED_CLAIM = /\b(?:claim|finding|defect|issue|assertion)\b[^.;。|]*(?:false|incorrect)\b/i;
const CORRECT_OWNERSHIP = /\b(?:behavior|ownership|cleanup)\b[^.;。|]*\bcorrect\b/i;
const NO_RESOURCE_LEAK = /\b(?:does not|doesn't|cannot|can't|will not|won't)\b[^.;。|]*(?:leak|skip|bypass|leave)/i;
const CLEANUP_STILL_RUNS = /\b(?:cleanup|release(?:Previews)?)\b[^.;。|]*\bstill runs?\b/i;
const JAPANESE_RELEASE_REFUTATION = /範囲外ではない|未解放ではない|後始末は実行される|解放される/;
const RESOURCE_REFUTATIONS = [
  REFUTED_CLAIM,
  CORRECT_OWNERSHIP,
  NO_RESOURCE_LEAK,
  CLEANUP_STILL_RUNS,
  JAPANESE_RELEASE_REFUTATION,
];

export default function assertBoundaryResourceRecall(output) {
  return hasFindingLine(output, {
    familyTag: 'resource-ownership',
    citation: /src\/interactive-import\.ts:(?:11|12)\b/,
    required: {
      defect: [
        DESTINATION_ACQUISITION,
        CLEANUP_BOUNDARY,
        ACQUISITION_OUTSIDE_BOUNDARY,
      ],
      impact: [
        MISSED_RELEASE,
      ],
      fix: [
        ACTIONABLE_FIX,
      ],
    },
    excluded: {
      defect: RESOURCE_REFUTATIONS,
      impact: RESOURCE_REFUTATIONS,
    },
  });
}
