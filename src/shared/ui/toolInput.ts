import { truncate } from './LogManager.js';
import { sanitizeTerminalText } from '../utils/text.js';
import { projectToolInput } from '../tool-activity/presentation.js';

function formatToolPreview(value: string, maxLength: number): string {
  return truncate(sanitizeTerminalText(value.replace(/\s+/g, ' ')), maxLength);
}

export function formatToolInput(tool: string, input: Record<string, unknown>): string {
  const knownTool = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(tool);
  return formatToolPreview(projectToolInput(tool, input), knownTool ? 60 : 50);
}
