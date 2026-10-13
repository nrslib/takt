import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';

const builtinsRoot = join(dirname(fileURLToPath(import.meta.url)), '../builtins');

function readFacet(facetsRoot, path) {
  return expandFacetIncludes({
    body: readFileSync(join(facetsRoot, path), 'utf8'),
    facetsRoots: [facetsRoot],
    repertoireDirs: [],
    allowedRoots: [facetsRoot],
  }).body;
}

// This focused evaluation uses supplied source and reports, not a live workflow.
export default function buildRemediationEvidencePrompt({ vars }) {
  const language = vars.language ?? 'ja';
  if (!['ja', 'en'].includes(language)) throw new Error(`Unknown facet language: ${language}`);
  const facetsRoot = join(builtinsRoot, language, 'facets');
  const facet = path => readFacet(facetsRoot, path);
  const reports = {
    'fix-plan.md': vars.fix_plan,
    'fix-report.md': vars.fix_report,
  };
  const instruction = facet('instructions/verify-fix.md').replace(
    /\{report:([^}]+)\}/g,
    (_match, name) => {
      if (typeof reports[name] !== 'string') throw new Error(`Missing report: ${name}`);
      return reports[name];
    },
  );
  return [
    facet('personas/coding-reviewer.md'),
    'これは修正完了検証の独立した机上評価です。以下に正本、現在のコード、最新のレビューと記録済み証跡を全文で提供します。外部ファイルの探索、編集、コマンド実行は不要です。提示されたコードと証跡の範囲で判断してください。',
    vars.task,
    instruction,
    facet('policies/review.md'),
    '検証結果を次の出力契約で報告してください。',
    facet('output-contracts/fix-verification.md'),
  ].join('\n\n');
}
