export const EXIT_NO_TEMPLATE = 3;
export const ERR_NO_TEMPLATE = 'REPORT_TEMPLATE_MISSING';

export class ReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

export function ensureTemplates(templates: string[]): void {
  if (templates.length === 0) {
    throw new ReportError(ERR_NO_TEMPLATE, 'no templates available');
  }
}

export function resolveExitCode(templates: string[]): number {
  if (templates.length === 0) {
    return EXIT_NO_TEMPLATE;
  }
  return 0;
}
