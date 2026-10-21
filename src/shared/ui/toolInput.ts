import { truncate } from './LogManager.js';
import { sanitizeTerminalText } from '../utils/text.js';

function formatToolPreview(value: string, maxLength: number): string {
  return truncate(sanitizeTerminalText(value.replace(/\s+/g, ' ')), maxLength);
}

export function formatToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
      return formatToolPreview(String(input.command || ''), 60);
    case 'Read':
    case 'Write':
    case 'Edit':
      return formatToolPreview(String(input.file_path || ''), 60);
    case 'Glob':
    case 'Grep':
      return formatToolPreview(String(input.pattern || ''), 60);
    default: {
      const firstKey = Object.keys(input)[0];
      return firstKey ? formatToolPreview(String(input[firstKey] || ''), 50) : '';
    }
  }
}
