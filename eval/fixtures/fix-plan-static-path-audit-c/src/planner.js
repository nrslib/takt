import { loadCompanionSchema } from './loader.js';
import {
  resolveCapabilities,
  resolveCompanionReference,
  resolveDirectCompanion,
  resolveScopedFacet,
} from './companion-consumer.js';

export function buildCompanionPlan(input) {
  const config = loadCompanionSchema();
  return {
    direct: resolveDirectCompanion(config),
    reference: resolveCompanionReference(config, input),
    capability: resolveCapabilities(config, input.mode),
    facet: resolveScopedFacet(config, input.packageName, input.facetName),
    terminal: 'plan with companion and capability paths',
  };
}
