export interface StoredImageAttachment {
  placeholder: string;
  tempPath: string;
  fileName: string;
}

export interface ManagerImageAttachmentReference extends ImageAttachmentReference {
  id: string;
}

export interface ImageAttachmentReference {
  placeholder: string;
  path: string;
}
