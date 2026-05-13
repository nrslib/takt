import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FallbackContext, Language } from '../../models/types.js';
import { getBuiltinFacetDir } from '../../../infra/config/paths.js';
import { renderTemplate } from '../../../shared/prompts/index.js';

export function renderFallbackNotice(context: FallbackContext, language: Language): string {
  const templatePath = join(getBuiltinFacetDir(language, 'instructions'), '_system', 'fallback-notice.md');
  const raw = readFileSync(templatePath, 'utf-8');
  return renderTemplate(raw, {
    fallback_reason: context.reason,
    step_name: context.stepName,
    original_iteration: String(context.originalIteration),
    fallback_reason_detail: context.reasonDetail,
    previous_provider: context.previousProvider,
    previous_model: context.previousModel ?? '',
    current_provider: context.currentProvider,
    current_model: context.currentModel ?? '',
    report_dir: context.reportDir,
  });
}
