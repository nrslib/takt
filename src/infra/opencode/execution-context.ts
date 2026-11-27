import type { OpenCodeSdkState } from './transport.js';

export class OpenCodeExecutionContext {
  constructor(private sdkState: OpenCodeSdkState) {}

  selectSdk(state: OpenCodeSdkState): void {
    this.sdkState = state;
  }

  get stale(): boolean {
    return this.sdkState.stale;
  }
}
