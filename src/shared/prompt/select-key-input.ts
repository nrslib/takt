const ESCAPE_SEQUENCE_TIMEOUT_MS = 500;
const MAX_PENDING_ESCAPE_SEQUENCE_LENGTH = 64;
const STRING_CONTROL_INTRODUCERS = new Set([']', 'P', '^', '_']);

interface SplitKeyInputResult {
  keys: string[];
  pendingInput: string;
}

function isAnsiFinalByte(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isAnsiSequenceByte(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x20 && code <= 0x3f;
}

function findStringControlEnd(input: string, startIndex: number): number | undefined {
  for (let index = startIndex + 2; index < input.length; index++) {
    if (index - startIndex >= MAX_PENDING_ESCAPE_SEQUENCE_LENGTH) {
      return startIndex + MAX_PENDING_ESCAPE_SEQUENCE_LENGTH - 1;
    }

    const character = input[index];
    if (character === '\x07') {
      return index;
    }
    if (character === '\x1B' && input[index + 1] === '\\') {
      return index + 1;
    }
  }

  return undefined;
}

function splitKeyInput(input: string): SplitKeyInputResult {
  const keys: string[] = [];

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character !== '\x1B') {
      if (character !== undefined) {
        keys.push(character);
      }
      continue;
    }

    const nextCharacter = input[index + 1];
    if (nextCharacter === undefined) {
      return { keys, pendingInput: input.slice(index) };
    }
    if (STRING_CONTROL_INTRODUCERS.has(nextCharacter)) {
      const sequenceEnd = findStringControlEnd(input, index);
      if (sequenceEnd === undefined) {
        return { keys, pendingInput: input.slice(index) };
      }
      keys.push(input.slice(index, sequenceEnd + 1));
      index = sequenceEnd;
      continue;
    }
    if (nextCharacter !== '[' && nextCharacter !== 'O') {
      keys.push(input.slice(index, index + 2));
      index++;
      continue;
    }

    let sequenceEnd = index + 2;
    while (sequenceEnd < input.length) {
      if (sequenceEnd - index >= MAX_PENDING_ESCAPE_SEQUENCE_LENGTH) {
        index += MAX_PENDING_ESCAPE_SEQUENCE_LENGTH - 1;
        break;
      }
      const sequenceCharacter = input[sequenceEnd];
      if (sequenceCharacter !== undefined && isAnsiFinalByte(sequenceCharacter)) {
        keys.push(input.slice(index, sequenceEnd + 1));
        index = sequenceEnd;
        break;
      }
      if (sequenceCharacter === undefined || !isAnsiSequenceByte(sequenceCharacter)) {
        index = sequenceEnd - 1;
        break;
      }
      sequenceEnd++;
    }

    if (sequenceEnd === input.length) {
      if (input.length - index >= MAX_PENDING_ESCAPE_SEQUENCE_LENGTH) {
        index += MAX_PENDING_ESCAPE_SEQUENCE_LENGTH - 1;
        continue;
      }
      return { keys, pendingInput: input.slice(index) };
    }
  }

  return { keys, pendingInput: '' };
}

export class KeyInputDecoder {
  private pendingInput = '';

  get hasPendingInput(): boolean {
    return this.pendingInput !== '';
  }

  push(input: string): string[] {
    const result = splitKeyInput(this.pendingInput + input);
    this.pendingInput = result.pendingInput;
    return result.keys;
  }

  expire(): string[] {
    const pendingInput = this.pendingInput;
    this.pendingInput = '';
    return pendingInput === '\x1B' ? [pendingInput] : [];
  }

  dispose(): void {
    this.pendingInput = '';
  }
}

export { ESCAPE_SEQUENCE_TIMEOUT_MS };
