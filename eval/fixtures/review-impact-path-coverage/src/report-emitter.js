export class ReportEmitter {
  emit(report, context) {
    if (!context?.scope || !Number.isInteger(context.iteration)) {
      throw new Error('Explicit report attribution is required');
    }
    return { report, scope: context.scope, iteration: context.iteration };
  }
}
