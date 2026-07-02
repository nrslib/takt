import type { ImageAttachmentCleanupOwner, InteractiveImageAttachment } from './imageAttachments.js';

export type InstructModeAction = 'execute' | 'save_task' | 'cancel';

export interface InstructModeResult extends ImageAttachmentCleanupOwner {
  action: InstructModeAction;
  task: string;
  attachments?: InteractiveImageAttachment[];
}

export interface InstructUIText {
  intro: string;
  resume: string;
  noConversation: string;
  summarizeFailed: string;
  continuePrompt: string;
  proposed: string;
  actionPrompt: string;
  actions: {
    execute: string;
    saveTask: string;
    continue: string;
  };
  cancelled: string;
}
