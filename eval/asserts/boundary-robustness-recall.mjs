import { hasFindingLine } from './boundary-finding-line.mjs';

const PREVIEW_OPERATION = /(?:downloadPreview|\bpreview(?: download)?\b|プレビュー(?:取得|ダウンロード)?)/i;
const PREVIEW_FAILURE = /(?:\b(?:exception|failure|error|rejection|rejects?|throws?)\b|失敗|例外|拒否|エラー)/i;
const ESCAPED_FAILURE = /(?:\b(?:escapes?|propagates?|bubbles?(?: up)?|uncaught|unhandled)\b|上位へ投げ|伝播)/i;
const PRIMARY_RESULT = /(?:\b(?:body|primary result|import result)\b|本文|主結果)/i;
const LOST_PRIMARY_RESULT = /(?:\b(?:lost|discarded|dropped)\b|\bnot returned\b|\bnever returned\b|\bprevents?\b[^.;。|]*\breturn(?:ed|ing)?\b|\baborts?\b[^.;。|]*(?:import|operation)|返せない|返されない|失われ|破棄)/i;
const ACTIONABLE_FIX = /(?:\b(?:catch|isolate|contain|handle|prevent)\b|捕捉|隔離|分離|封じ込)/i;

const REFUTED_CLAIM = /\b(?:claim|finding|defect|issue|assertion)\b[^.;。|]*(?:false|incorrect)\b/i;
const CORRECT_FAILURE_BOUNDARY = /\b(?:behavior|failure handling|boundary)\b[^.;。|]*\bcorrect\b/i;
const FAILURE_DOES_NOT_ESCAPE = /\b(?:does not|doesn't)\b[^.;。|]*(?:throw|abort|propagate|escape)/i;
const FAILURE_IS_CAUGHT = /\b(?:is caught|caught and continues?|continues? with)\b/i;
const JAPANESE_CONTAINED_FAILURE = /伝播することはない|捕捉され[^。|]*継続|例外は捕捉/;
const PRESERVED_PRIMARY_RESULT = /\b(?:body|primary result|import result)\b[^.;。|]*(?:preserved|retained)\b/i;
const JAPANESE_PRESERVED_RESULT = /返せないことはない|(?:本文|主結果)[^。|]*(?:保持される|維持される)/;

export default function assertBoundaryRobustnessRecall(output) {
  return hasFindingLine(output, {
    familyTag: 'failure-boundary',
    citation: /src\/import-document\.ts:11\b/,
    required: {
      defect: [
        PREVIEW_OPERATION,
        PREVIEW_FAILURE,
        ESCAPED_FAILURE,
      ],
      impact: [
        PRIMARY_RESULT,
        LOST_PRIMARY_RESULT,
      ],
      fix: [
        ACTIONABLE_FIX,
      ],
    },
    excluded: {
      defect: [
        REFUTED_CLAIM,
        CORRECT_FAILURE_BOUNDARY,
        FAILURE_DOES_NOT_ESCAPE,
        FAILURE_IS_CAUGHT,
        JAPANESE_CONTAINED_FAILURE,
      ],
      impact: [
        REFUTED_CLAIM,
        PRESERVED_PRIMARY_RESULT,
        FAILURE_IS_CAUGHT,
        JAPANESE_PRESERVED_RESULT,
      ],
    },
  });
}
