import { Logger } from './logger.js';

export function generateReport(templates: string[], logger: Logger): string {
  if (templates.length === 0) {
    logger.log('warn', 'report: no templates provided; skipping generation');
    throw new Error('Failed to generate report: no templates available');
  }
  return `レポート: ${templates.length} 件のテンプレートを処理しました`;
}
