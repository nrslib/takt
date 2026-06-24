import type { FacetType } from '../../../infra/config/index.js';

export const FACET_SECTION_TO_DIR = {
  instructions: 'instructions',
  knowledge: 'knowledge',
  personas: 'personas',
  policies: 'policies',
  report_formats: 'output-contracts',
} as const satisfies Record<string, FacetType>;

export const BUILDER_READ_TOOLS = ['Read', 'Glob', 'Grep'];
export const BUILDER_GO_TOOLS = BUILDER_READ_TOOLS;

export const PATH_MENTION_PREFIX = "(?:^|\\s|[\"'([{<（「『【])";
export const PATH_MENTION_TERMINATOR = "(?=$|\\s|[.,;、。；:?？\"')\\]}）>」』】])";
