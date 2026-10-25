import { AsyncLocalStorage } from 'node:async_hooks';

const privateDiagnostics = new AsyncLocalStorage<boolean>();

/** Scope suppression to this async call, including its provider callbacks. */
export function withoutDiagnosticLogging<T>(action: () => T): T {
  return privateDiagnostics.run(true, action);
}

export function diagnosticLoggingSuppressed(): boolean {
  return privateDiagnostics.getStore() === true;
}
