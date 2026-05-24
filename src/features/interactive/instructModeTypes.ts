export type InstructModeAction = 'execute' | 'save_task' | 'cancel';

export interface InstructModeResult {
  action: InstructModeAction;
  task: string;
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
