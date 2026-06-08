import { getErrorMessage } from '../../shared/utils/index.js';
import { warn } from '../../shared/ui/index.js';

export function reportClipboardImagePasteError(error: unknown): void {
  warn(`Clipboard image paste failed: ${getErrorMessage(error)}`);
}
