import { z } from 'zod/v4';
import { RAW_FINDING_FIELD_LIMITS } from './finding-contract-limits.js';

/** Unnamespaced raw finding ID accepted from a reviewer provider. */
export const ProviderRawFindingIdSchema = z.string()
  .min(1)
  .max(RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars);

/** Engine-namespaced raw finding ID carried across the wire and persistence. */
export const RawFindingIdSchema = z.string()
  .min(1)
  .max(RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars);
