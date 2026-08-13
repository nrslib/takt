export function createLocalStepCache() {
  const values = new Map();
  return {
    put(step, value) {
      values.set(step.name, value);
    },
    get(step) {
      return values.get(step.name);
    },
  };
}
