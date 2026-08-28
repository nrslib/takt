export function selectDynamicFacets(config, input) {
  const selector = config.dynamic_facets.selector;
  const tags = input.step.tags;
  const candidates = input.facet_pool.candidates.filter((candidate) =>
    tags.includes(candidate.tag));

  return {
    persona: selector.persona,
    instruction: selector.instruction,
    inputState: { step: input.step.name, tags },
    candidateIds: candidates.map(({ id }) => id),
    terminal: 'selected facet ids',
  };
}
