import { z } from 'zod/v4';
import {
  OPERATION_ATTEMPT_STATUSES,
  OPERATION_JOURNAL_STAGES,
  type OperationJournalDocument,
  type OperationJournalJsonValue,
} from './operation-journal-types.js';

const OperationJournalJsonValueSchema: z.ZodType<OperationJournalJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(OperationJournalJsonValueSchema),
    z.record(z.string(), OperationJournalJsonValueSchema),
  ])
);

const OperationOwnerSchema = z.object({
  generation: z.number().int().min(0),
  claimToken: z.string().min(1),
}).strict();

const OperationAttemptRecordSchema = z.object({
  id: z.string().min(1),
  attemptToken: z.string().min(1),
  sequence: z.number().int().positive(),
  status: z.enum(OPERATION_ATTEMPT_STATUSES),
  payload: OperationJournalJsonValueSchema,
}).strict();

const OperationJournalChildSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  revision: z.number().int().min(0),
  stage: z.enum(OPERATION_JOURNAL_STAGES),
  payload: OperationJournalJsonValueSchema,
  attempts: z.array(OperationAttemptRecordSchema),
}).strict();

const OperationJournalParentSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  revision: z.number().int().min(0),
  stage: z.enum(OPERATION_JOURNAL_STAGES),
  payload: OperationJournalJsonValueSchema,
  owner: OperationOwnerSchema,
  children: z.array(OperationJournalChildSchema),
}).strict();

export const OperationJournalDocumentSchema: z.ZodType<OperationJournalDocument> = z.object({
  version: z.literal(1),
  parents: z.array(OperationJournalParentSchema),
}).strict().superRefine((document, context) => {
  const parentIds = new Set<string>();
  document.parents.forEach((parent, parentIndex) => {
    if (parentIds.has(parent.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate operation parent id: ${parent.id}`,
        path: ['parents', parentIndex, 'id'],
      });
    }
    parentIds.add(parent.id);

    const childIds = new Set<string>();
    let minimumParentRevision = parent.owner.generation;
    parent.children.forEach((child, childIndex) => {
      minimumParentRevision += 1 + child.revision;
      if (childIds.has(child.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate operation child id: ${child.id}`,
          path: ['parents', parentIndex, 'children', childIndex, 'id'],
        });
      }
      childIds.add(child.id);

      const attemptIds = new Set<string>();
      child.attempts.forEach((attempt, attemptIndex) => {
        if (attemptIds.has(attempt.id)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate operation attempt id: ${attempt.id}`,
            path: ['parents', parentIndex, 'children', childIndex, 'attempts', attemptIndex, 'id'],
          });
        }
        attemptIds.add(attempt.id);
        if (attempt.sequence !== attemptIndex + 1) {
          context.addIssue({
            code: 'custom',
            message: `Operation attempt sequence must be ${attemptIndex + 1}`,
            path: [
              'parents',
              parentIndex,
              'children',
              childIndex,
              'attempts',
              attemptIndex,
              'sequence',
            ],
          });
        }
      });
      if (child.revision < child.attempts.length) {
        context.addIssue({
          code: 'custom',
          message: 'Operation child revision cannot be lower than its attempt count',
          path: ['parents', parentIndex, 'children', childIndex, 'revision'],
        });
      }
    });
    if (parent.revision < minimumParentRevision) {
      context.addIssue({
        code: 'custom',
        message: `Operation parent revision cannot be lower than ${minimumParentRevision}`,
        path: ['parents', parentIndex, 'revision'],
      });
    }
  });
});

export function parseOperationJournalDocument(value: unknown): OperationJournalDocument {
  return OperationJournalDocumentSchema.parse(value);
}
