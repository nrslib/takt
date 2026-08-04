import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  FindingLifecycleEntityHead,
  FindingLifecycleEvent,
} from './finding-types.js';

function sameHead(
  left: FindingLifecycleEntityHead,
  right: FindingLifecycleEntityHead,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function currentFindingHead(
  lifecycleEvents: readonly FindingLifecycleEvent[],
  findingId: string,
): FindingLifecycleEntityHead | undefined {
  return lifecycleEvents.flatMap((event) => event.transitions)
    .filter((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === findingId
    ))
    .at(-1)?.after;
}

export function hasVerifiedOrdinaryLifecycleCoverage(input: {
  lifecycleEvents: readonly FindingLifecycleEvent[];
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
}): boolean {
  if (
    input.expectedHead.entityKind !== 'finding'
    || input.expectedHead.entityId !== input.findingId
  ) {
    return false;
  }
  const currentHead = currentFindingHead(input.lifecycleEvents, input.findingId);
  if (currentHead === undefined) {
    return false;
  }
  if (sameHead(input.expectedHead, currentHead)) {
    return true;
  }
  const anchorExists = input.lifecycleEvents.some((event) => (
    event.eventId === input.expectedHead.eventId
    && event.transitions.some((transition) => sameHead(transition.after, input.expectedHead))
  ));
  if (!anchorExists) {
    return false;
  }
  let cursor = input.expectedHead;
  for (const event of input.lifecycleEvents) {
    const transitions = event.transitions.filter((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === input.findingId
      && transition.after.revision > cursor.revision
    ));
    for (const transition of transitions) {
      if (
        transition.before === null
        || transition.after.revision !== cursor.revision + 1
        || !sameHead(transition.before, cursor)
      ) {
        return false;
      }
      cursor = transition.after;
    }
  }
  return sameHead(cursor, currentHead);
}
