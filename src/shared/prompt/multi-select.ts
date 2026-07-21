import {
  selectOption,
  type InteractiveSelectCallbacks,
  type SelectOptionItem,
} from './select.js';

export interface MultipleSelectOptions {
  cancelLabel?: string;
  instructions?: string;
}

const DEFAULT_MULTIPLE_SELECT_INSTRUCTIONS = '↑↓ to move, Space to toggle, Enter to confirm';

function normalizeInstructions(instructions: string | undefined): string {
  return instructions === '' || instructions === undefined
    ? DEFAULT_MULTIPLE_SELECT_INSTRUCTIONS
    : instructions;
}

function assertUniqueOptionValues<T extends string>(options: SelectOptionItem<T>[]): void {
  const values = new Set<T>();

  for (const option of options) {
    if (values.has(option.value)) {
      throw new Error(`Multiple-select options must have unique values: ${option.value}`);
    }
    values.add(option.value);
  }
}

function decorateOptions<T extends string>(
  options: SelectOptionItem<T>[],
  selectedValues: T[],
): SelectOptionItem<T>[] {
  return options.map((option) => ({
    ...option,
    label: `${selectedValues.includes(option.value) ? '[x]' : '[ ]'} ${option.label}`,
  }));
}

function toggleSelectedValue<T extends string>(selectedValues: T[], value: T): T[] {
  return selectedValues.includes(value)
    ? selectedValues.filter((selectedValue) => selectedValue !== value)
    : [...selectedValues, value];
}

function normalizeInitialValues<T extends string>(
  options: SelectOptionItem<T>[],
  initialValues: T[],
): T[] {
  const availableValues = new Set(options.map((option) => option.value));
  const normalizedValues: T[] = [];

  for (const value of initialValues) {
    if (availableValues.has(value) && !normalizedValues.includes(value)) {
      normalizedValues.push(value);
    }
  }

  return normalizedValues;
}

export async function selectMultipleOptions<T extends string>(
  message: string,
  options: SelectOptionItem<T>[],
  initialValues: T[],
  settings?: MultipleSelectOptions,
): Promise<T[] | null> {
  assertUniqueOptionValues(options);
  let selectedValues = normalizeInitialValues(options, initialValues);
  const callbacks: InteractiveSelectCallbacks<T> = {
    cancelLabel: settings?.cancelLabel,
    instructions: normalizeInstructions(settings?.instructions),
    showConfirmation: false,
    onKeyPress(key, value) {
      if (key !== ' ') return null;

      selectedValues = toggleSelectedValue(selectedValues, value);
      return decorateOptions(options, selectedValues);
    },
  };

  if (options.length === 0) return null;

  const confirmed = await selectOption(message, decorateOptions(options, selectedValues), callbacks);
  return confirmed === null ? null : selectedValues;
}
