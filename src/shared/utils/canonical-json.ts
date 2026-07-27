import { types } from 'node:util';
import { compareBinaryStrings } from './binary-string-comparator.js';

function unsupportedValue(value: unknown): never {
  const kind = value === null ? 'null' : typeof value;
  throw new TypeError(`Canonical JSON does not support ${kind} values`);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoInheritedToJson(value: object): void {
  let prototype = Object.getPrototypeOf(value);
  while (prototype !== null) {
    if (types.isProxy(prototype)) {
      throw new TypeError('Canonical JSON does not support Proxy values');
    }
    if (Object.getOwnPropertyDescriptor(prototype, 'toJSON') !== undefined) {
      throw new TypeError('Canonical JSON does not support inherited toJSON');
    }
    prototype = Object.getPrototypeOf(prototype);
  }
}

function snapshotDataDescriptors(value: object): Map<PropertyKey, PropertyDescriptor> {
  if (types.isProxy(value)) {
    throw new TypeError('Canonical JSON does not support Proxy values');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor === undefined) {
      throw new TypeError('Canonical JSON could not snapshot a property descriptor');
    }
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError('Canonical JSON does not support accessor properties');
    }
    snapshot.set(key, descriptor);
  }
  return snapshot;
}

function serializePrimitive(value: null | boolean | string | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON does not support non-finite numbers');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Canonical JSON primitive could not be serialized');
  }
  return serialized;
}

function serializeJsonValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
  indentation: string,
  visited: object[] | undefined,
): string {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
    || typeof value === 'number'
  ) {
    return serializePrimitive(value);
  }
  if (
    value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    return unsupportedValue(value);
  }
  if (types.isProxy(value)) {
    throw new TypeError('Canonical JSON does not support Proxy values');
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('Canonical JSON supports only arrays and plain objects');
  }
  if (seen.has(value)) {
    throw new TypeError('Canonical JSON does not support cyclic values or repeated object references');
  }
  assertNoInheritedToJson(value);
  const descriptors = snapshotDataDescriptors(value);

  seen.add(value);
  visited?.push(value);
  const nextDepth = depth + 1;
  const separator = indentation.length === 0 ? ',' : ',\n';
  const prefix = indentation.repeat(nextDepth);
  const suffix = indentation.repeat(depth);
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.get('length');
    if (
      lengthDescriptor === undefined
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new TypeError('Canonical JSON received an invalid array length descriptor');
    }
    const length = lengthDescriptor.value;
    const serializedItems = Array.from({ length }, (_unused, index) => {
      const descriptor = descriptors.get(String(index));
      if (descriptor === undefined) {
        throw new TypeError('Canonical JSON does not support sparse arrays');
      }
      if (descriptor.enumerable !== true) {
        throw new TypeError('Canonical JSON does not support non-enumerable array values');
      }
      return serializeJsonValue(descriptor.value, seen, nextDepth, indentation, visited);
    });
    if (descriptors.size !== length + 1) {
      throw new TypeError('Canonical JSON does not support extra array properties');
    }
    const serialized = serializedItems.length === 0
      ? '[]'
      : indentation.length === 0
      ? `[${serializedItems.join(separator)}]`
      : `[\n${prefix}${serializedItems.join(`${separator}${prefix}`)}\n${suffix}]`;
    return serialized;
  }

  const serializedEntries = [...descriptors].map(([key, descriptor]) => {
    if (typeof key !== 'string') {
      throw new TypeError('Canonical JSON does not support symbol-keyed properties');
    }
    if (descriptor.enumerable !== true) {
      throw new TypeError('Canonical JSON does not support non-enumerable object values');
    }
    return [key, descriptor.value] as const;
  })
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([key, descriptorValue]) => (
      `${JSON.stringify(key)}:${indentation.length === 0 ? '' : ' '}${
        serializeJsonValue(descriptorValue, seen, nextDepth, indentation, visited)
      }`
    ));
  const serialized = serializedEntries.length === 0
    ? '{}'
    : indentation.length === 0
    ? `{${serializedEntries.join(separator)}}`
    : `{\n${prefix}${serializedEntries.join(`${separator}${prefix}`)}\n${suffix}}`;
  return serialized;
}

export function canonicalJson(value: unknown, space = 0): string {
  if (!Number.isSafeInteger(space) || space < 0 || space > 10) {
    throw new TypeError('Canonical JSON indentation must be an integer from 0 through 10');
  }
  return serializeJsonValue(value, new Set(), 0, ' '.repeat(space), undefined);
}

export function compareCanonicalJsonValues(left: unknown, right: unknown): number {
  return compareBinaryStrings(canonicalJson(left), canonicalJson(right));
}

export function deepFreezeCanonicalJsonValue<T extends object>(value: T): T {
  const visited: object[] = [];
  serializeJsonValue(value, new Set(), 0, '', visited);
  for (let index = visited.length - 1; index >= 0; index -= 1) {
    Object.freeze(visited[index]!);
  }
  return value;
}
