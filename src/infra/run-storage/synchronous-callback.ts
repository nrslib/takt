export function isNativeAsyncFunction(
  callback: (...arguments_: never[]) => unknown,
): boolean {
  return callback.constructor.name === 'AsyncFunction';
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof Reflect.get(value, 'then') === 'function';
}
