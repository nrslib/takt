import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  deepFreezeCanonicalJsonValue,
} from '../shared/utils/canonical-json.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';

describe('canonicalJson', () => {
  it('orders integer-like and Unicode keys with compareBinaryStrings semantics', () => {
    const value = {
      10: 'ten',
      2: 'two',
      é: 'nfc',
      'e\u0301': 'decomposed',
      '\u{1F601}': 'grinning-eyes',
      '\u{1F600}': 'grinning',
      A: 'upper',
      a: 'lower',
    };

    expect(canonicalJson(value)).toBe(
      '{"10":"ten","2":"two","A":"upper","a":"lower","é":"decomposed","é":"nfc","😀":"grinning","😁":"grinning-eyes"}',
    );
  });

  it('uses JSON.stringify-compatible string escaping and finite number rendering', () => {
    const value = {
      escaped: '"\\\b\f\n\r\t\u0000',
      numbers: [-0, 1.5, 1e+21, 1e-7],
    };

    expect(canonicalJson(value)).toBe(
      `{"escaped":${JSON.stringify(value.escaped)},"numbers":[0,1.5,1e+21,1e-7]}`,
    );
  });

  it.each([
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('unsupported')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date('2026-07-27T00:00:00.000Z')],
    ['custom class', new (class Unsupported {})()],
    ['toJSON object', { value: 1, toJSON: () => ({ value: 1 }) }],
  ])('rejects unsupported %s values', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('rejects unsupported nested values, sparse arrays, and cycles', () => {
    expect(() => canonicalJson({ nested: undefined })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson(new Array(1))).toThrow('sparse arrays');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('cyclic values');
  });

  it('rejects Proxy and accessors without evaluating user code', () => {
    let proxyReads = 0;
    const proxy = new Proxy({ value: 1 }, {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => canonicalJson(proxy)).toThrow('Proxy');
    expect(proxyReads).toBe(0);

    let getterReads = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 1;
      },
    });
    expect(() => canonicalJson(accessor)).toThrow('accessor');
    expect(getterReads).toBe(0);
  });

  it('rejects shared object references across the full value graph', () => {
    const shared = { value: 1 };
    expect(() => canonicalJson({ left: shared, right: shared }))
      .toThrow('repeated object references');
  });

  it('rejects array accessors, inherited toJSON, and extra own properties', () => {
    const accessorArray = [1];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => 1,
    });
    expect(() => canonicalJson(accessorArray)).toThrow('accessor');

    const inheritedToJson = [1];
    Object.setPrototypeOf(inheritedToJson, {
      toJSON: () => ['forged'],
    });
    expect(() => canonicalJson(inheritedToJson)).toThrow('inherited toJSON');

    const extraProperty = [1] as number[] & { hidden?: string };
    extraProperty.hidden = 'not-json-array-data';
    expect(() => canonicalJson(extraProperty)).toThrow('extra array properties');
  });

  it('accepts null-prototype data objects', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 }),
    });
    expect(canonicalJson(value)).toBe('{"nested":{"value":1}}');
  });

  it('does not freeze any visited node when strict validation fails later', () => {
    const child = { value: 1 };
    const invalid = {
      aValidChild: child,
      zInvalidValue: undefined,
    };

    expect(() => deepFreezeCanonicalJsonValue(invalid)).toThrow(TypeError);
    expect(Object.isFrozen(invalid)).toBe(false);
    expect(Object.isFrozen(child)).toBe(false);
  });

  it('serializes representative existing ledger input without changing array order', () => {
    const ledger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-27T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      stopBudget: {
        roundMarkers: ['round-2', 'round-1'],
        firstRoundAt: '2026-07-27T00:00:00.000Z',
        exhausted: false,
      },
    };

    const parsed = JSON.parse(canonicalJson(ledger)) as FindingLedger;
    expect(parsed).toEqual(ledger);
    expect(parsed.stopBudget?.roundMarkers).toEqual(['round-2', 'round-1']);
  });
});
