import type {
  FindingManagerConflict,
  FindingManagerDisputeNote,
} from './types.js';

const ENGINE_DERIVED_WAIVER_CONFLICT = Symbol(
  'takt.finding-contract.engine-derived-waiver-conflict',
);

type EngineDerivedWaiverConflict = FindingManagerConflict & {
  [ENGINE_DERIVED_WAIVER_CONFLICT]: true;
};

type EngineDerivedWaiverDisputeNote = FindingManagerDisputeNote & {
  [ENGINE_DERIVED_WAIVER_CONFLICT]: true;
};

const engineDerivedWaiverDisputeNotes = new WeakSet<object>();

function markEngineDerivedWaiver<T extends object>(value: T): T & {
  [ENGINE_DERIVED_WAIVER_CONFLICT]: true;
} {
  Object.defineProperty(value, ENGINE_DERIVED_WAIVER_CONFLICT, {
    value: true,
    enumerable: false,
  });
  return value as T & { [ENGINE_DERIVED_WAIVER_CONFLICT]: true };
}

export function createEngineDerivedWaiverConflict(
  findingId: string,
): EngineDerivedWaiverConflict {
  return markEngineDerivedWaiver({
    findingIds: [findingId],
    rawFindingIds: [],
    description: `Waiver for finding "${findingId}" conflicts with evidence that it still persists in the same round`,
  });
}

export function createEngineDerivedWaiverDisputeNote(input: {
  findingId: string;
  reason: string;
  evidence: string;
}): EngineDerivedWaiverDisputeNote {
  const note = { ...input } as EngineDerivedWaiverDisputeNote;
  engineDerivedWaiverDisputeNotes.add(note);
  return note;
}

export function isEngineDerivedWaiverConflict(
  conflict: FindingManagerConflict,
): conflict is EngineDerivedWaiverConflict {
  return Reflect.get(conflict, ENGINE_DERIVED_WAIVER_CONFLICT) === true;
}

export function isEngineDerivedWaiverDisputeNote(
  note: FindingManagerDisputeNote,
): note is EngineDerivedWaiverDisputeNote {
  return engineDerivedWaiverDisputeNotes.has(note);
}

export function plainFindingManagerConflict(
  conflict: FindingManagerConflict,
): FindingManagerConflict {
  return {
    findingIds: [...conflict.findingIds],
    rawFindingIds: [...conflict.rawFindingIds],
    description: conflict.description,
  };
}
