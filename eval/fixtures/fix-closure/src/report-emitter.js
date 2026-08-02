export class ReportEmitter {
  constructor(activeContext) {
    this.activeContext = activeContext;
  }

  setActiveContext(context) {
    this.activeContext = context;
  }

  emit(report, attribution) {
    return {
      report,
      scope: attribution?.scope ?? this.activeContext.scope,
      iteration: attribution?.iteration ?? this.activeContext.iteration,
    };
  }
}
