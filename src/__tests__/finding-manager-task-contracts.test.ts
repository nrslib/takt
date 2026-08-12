import { describe, expect, it } from 'vitest';
import {
  FindingEntityBindingTaskOutputJsonSchema,
  MainManagerControlTaskOutputJsonSchema,
  MainManagerRawTaskOutputJsonSchema,
  parseFindingEntityBindingTaskOutput,
} from '../core/workflow/findings/manager-task-contracts.js';
import { RAW_FINDING_FIELD_LIMITS } from '../core/models/finding-contract-limits.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectConstrainedSchemas(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectConstrainedSchemas);
  }
  if (!isRecord(value)) {
    return [];
  }

  const descendants = Object.values(value).flatMap(collectConstrainedSchemas);
  return Object.hasOwn(value, 'enum')
    ? [value, ...descendants]
    : descendants;
}

function enumValues(
  properties: Readonly<Record<string, unknown>>,
  propertyName: string,
): unknown {
  const property = properties[propertyName];
  return isRecord(property) ? property.enum : null;
}

describe('finding manager task contracts', () => {
  it.each([
    ['raw task', MainManagerRawTaskOutputJsonSchema],
    ['control task', MainManagerControlTaskOutputJsonSchema],
    ['entity binding task', FindingEntityBindingTaskOutputJsonSchema],
  ])('declares matching string types for every enum in the projected %s output schema', (
    _name,
    schema,
  ) => {
    const constrainedSchemas = collectConstrainedSchemas(schema);

    expect(constrainedSchemas.length).toBeGreaterThan(0);
    for (const constrainedSchema of constrainedSchemas) {
      const values = constrainedSchema.enum;
      expect(constrainedSchema.type).toBe('string');
      expect(Array.isArray(values)).toBe(true);
      expect((values as unknown[]).every((value) => typeof value === 'string')).toBe(true);
    }
    const serialized = JSON.stringify(schema);
    for (const unsupportedKeyword of ['const', 'oneOf', 'pattern', 'uniqueItems']) {
      expect(serialized).not.toContain(`"${unsupportedKeyword}"`);
    }
  });

  it('snapshots the projected manager decision shapes used by Sol', () => {
    const rawAlternatives = MainManagerRawTaskOutputJsonSchema
      .properties.decisions.items.anyOf;
    const controlAlternatives = MainManagerControlTaskOutputJsonSchema
      .properties.evaluations.items.properties.result.anyOf;
    const entityDecision = FindingEntityBindingTaskOutputJsonSchema
      .properties.decisions.items;

    expect({
      raw: {
        required: MainManagerRawTaskOutputJsonSchema.required,
        maxItems: MainManagerRawTaskOutputJsonSchema.properties.decisions.maxItems,
        alternatives: rawAlternatives.map((alternative) => ({
          required: alternative.required,
          decision: enumValues(alternative.properties, 'decision'),
          anchorRelevance: enumValues(alternative.properties, 'anchorRelevance'),
        })),
      },
      entityBinding: {
        required: FindingEntityBindingTaskOutputJsonSchema.required,
        maxItems: FindingEntityBindingTaskOutputJsonSchema.properties.decisions.maxItems,
        decisionRequired: entityDecision.required,
        decision: enumValues(entityDecision.properties, 'decision'),
      },
      control: {
        required: MainManagerControlTaskOutputJsonSchema.required,
        maxItems: MainManagerControlTaskOutputJsonSchema.properties.evaluations.maxItems,
        evaluationRequired: MainManagerControlTaskOutputJsonSchema
          .properties.evaluations.items.required,
        results: controlAlternatives.map((alternative) => ({
          required: alternative.required,
          kind: enumValues(alternative.properties, 'kind'),
          basis: enumValues(alternative.properties, 'basis'),
        })),
        selectedIntentIdType: MainManagerControlTaskOutputJsonSchema
          .properties.selectedIntentId.type,
      },
    }).toMatchInlineSnapshot(`
      {
        "control": {
          "evaluationRequired": [
            "intentId",
            "result",
          ],
          "maxItems": 16,
          "required": [
            "taskId",
            "evaluations",
            "selectedIntentId",
          ],
          "results": [
            {
              "basis": null,
              "kind": [
                "no_action",
              ],
              "required": [
                "kind",
                "reason",
              ],
            },
            {
              "basis": null,
              "kind": [
                "waive",
                "note",
              ],
              "required": [
                "kind",
                "findingId",
                "reason",
                "evidence",
              ],
            },
            {
              "basis": null,
              "kind": [
                "resolve",
                "keep",
              ],
              "required": [
                "kind",
                "conflictId",
                "evidence",
              ],
            },
            {
              "basis": null,
              "kind": [
                "invalidate",
              ],
              "required": [
                "kind",
                "findingId",
                "evidence",
              ],
            },
            {
              "basis": [
                "outside_task_scope",
              ],
              "kind": [
                "dismiss",
              ],
              "required": [
                "kind",
                "anomalyId",
                "basis",
                "reason",
                "taskQuote",
                "claimQuote",
              ],
            },
            {
              "basis": [
                "outside_task_scope",
              ],
              "kind": [
                "dismiss",
              ],
              "required": [
                "kind",
                "findingId",
                "basis",
                "reason",
                "taskQuote",
              ],
            },
            {
              "basis": [
                "outside_contract_jurisdiction",
                "false_positive",
                "overreach",
                "no_issue_after_verification",
              ],
              "kind": [
                "dismiss",
              ],
              "required": [
                "kind",
                "findingId",
                "basis",
                "reason",
                "evidence",
              ],
            },
          ],
          "selectedIntentIdType": [
            "string",
            "null",
          ],
        },
        "entityBinding": {
          "decision": [
            "bind_existing",
            "new_entity",
            "ambiguous",
          ],
          "decisionRequired": [
            "rawFindingId",
            "decision",
            "findingId",
            "groupRawFindingId",
            "reason",
          ],
          "maxItems": 128,
          "required": [
            "taskId",
            "decisions",
          ],
        },
        "raw": {
          "alternatives": [
            {
              "anchorRelevance": null,
              "decision": [
                "same",
                "new",
                "resolved",
                "reopened",
                "conflict",
                "unsupported",
              ],
              "required": [
                "componentId",
                "rawFindingId",
                "decision",
                "findingId",
                "evidence",
              ],
            },
            {
              "anchorRelevance": [
                "relevant",
                "not_relevant",
              ],
              "decision": [
                "same",
                "new",
                "resolved",
                "reopened",
                "conflict",
                "unsupported",
              ],
              "required": [
                "componentId",
                "rawFindingId",
                "decision",
                "findingId",
                "evidence",
                "anchorRelevance",
              ],
            },
          ],
          "maxItems": 16,
          "required": [
            "taskId",
            "decisions",
          ],
        },
      }
    `);
  });

  it('allows the empty bind_existing group sentinel without relaxing raw finding ID limits', () => {
    const taskId = 'a'.repeat(64);
    const rawFindingId = 'raw-1';
    const bindExisting = {
      taskId,
      decisions: [{
        rawFindingId,
        decision: 'bind_existing',
        findingId: 'F-0001',
        groupRawFindingId: '',
        reason: 'Matches the existing semantic entity.',
      }],
    };

    expect(parseFindingEntityBindingTaskOutput(bindExisting)).toEqual(bindExisting);

    const maximumGroupRawFindingId = 'x'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    );
    const newEntity = {
      taskId,
      decisions: [{
        rawFindingId,
        decision: 'new_entity',
        findingId: '',
        groupRawFindingId: maximumGroupRawFindingId,
        reason: 'Represents a distinct semantic entity.',
      }],
    };
    expect(parseFindingEntityBindingTaskOutput(newEntity)).toEqual(newEntity);
    expect(() => parseFindingEntityBindingTaskOutput({
      ...newEntity,
      decisions: [{
        ...newEntity.decisions[0],
        groupRawFindingId: `${maximumGroupRawFindingId}x`,
      }],
    })).toThrow();

    expect(
      FindingEntityBindingTaskOutputJsonSchema
        .properties.decisions.items.properties.groupRawFindingId,
    ).toEqual({
      type: 'string',
      minLength: 0,
      maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    });
  });
});
