export type Inquiry = {
  id: string;
  customerName: string;
  customerEmail: string;
  subject: string;
  receivedLabel: string;
  receivedDateTime: string;
  body: string;
  savedReply: string;
};

export type FeedbackKind = "success" | "error" | "warning" | "info";

export type Feedback = {
  kind: FeedbackKind;
  message: string;
};

export type SaveState = "idle" | "saving" | "success" | "error";
