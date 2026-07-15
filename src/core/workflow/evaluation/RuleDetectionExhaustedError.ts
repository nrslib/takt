export class RuleDetectionExhaustedError extends Error {
  constructor(stepName: string) {
    super(`Status not found for step "${stepName}": no rule matched after all detection phases`);
    this.name = 'RuleDetectionExhaustedError';
  }
}
