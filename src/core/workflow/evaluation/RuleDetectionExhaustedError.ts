export class RuleDetectionExhaustedError extends Error {
  constructor(stepName: string, detail = '') {
    super(`Status not found for step "${stepName}": no rule matched after all detection phases${detail}`);
    this.name = 'RuleDetectionExhaustedError';
  }
}
