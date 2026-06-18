import type { CapabilityAwareStructuredCaller } from './capability-aware-structured-caller.js';

export type Assert<T extends true> = T;

export type CapabilityAwareMorePartsOptions = Parameters<
  CapabilityAwareStructuredCaller['requestMoreParts']
>[4];

export type RequestMorePartsDoesNotAcceptInspectTools = Assert<
  'inspectTools' extends keyof CapabilityAwareMorePartsOptions ? false : true
>;
