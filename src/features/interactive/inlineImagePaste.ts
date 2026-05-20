export interface PastedImage {
  mimeType: string;
  data: Buffer;
}

export type ImagePasteHandler = (image: PastedImage) => Promise<string>;

export const OSC_IMAGE_PREFIX = '\x1B]1337;File=';
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING_INLINE_IMAGE_CHARS = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 1024;

export type InlineImageSequence =
  | { status: 'incomplete' }
  | { status: 'passthrough'; sequenceEnd: number }
  | { status: 'image'; image: PastedImage; sequenceEnd: number };

function getParamValue(params: string[], name: string): string | null {
  const prefix = `${name}=`;
  const param = params.find((value) => value.startsWith(prefix));
  return param ? param.slice(prefix.length) : null;
}

function isBase64Encoded(value: string, decoded: string): boolean {
  return Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
}

function decodeInlineFileName(value: string): string {
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return isBase64Encoded(value, decoded) ? decoded : value;
}

function inferMimeTypeFromName(nameParam: string | null): string | null {
  if (!nameParam) {
    return null;
  }

  const fileName = decodeInlineFileName(nameParam).toLowerCase();
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.gif')) return 'image/gif';
  if (fileName.endsWith('.webp')) return 'image/webp';
  return null;
}

function inferMimeTypeFromMagicBytes(data: Buffer): string | null {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.subarray(0, 6).equals(Buffer.from('GIF87a')) || data.subarray(0, 6).equals(Buffer.from('GIF89a'))) {
    return 'image/gif';
  }
  if (data.length >= 12 && data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return 'image/webp';
  }
  return null;
}

function validateDeclaredSize(params: string[], encodedData: string): void {
  const sizeParam = getParamValue(params, 'size');
  if (!sizeParam) {
    return;
  }

  const declaredSize = Number.parseInt(sizeParam, 10);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new Error(`Invalid pasted inline image size: ${sizeParam}`);
  }
  if (declaredSize > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`Pasted inline image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte limit.`);
  }

  const maxEncodedLength = Math.ceil(declaredSize / 3) * 4 + 4;
  if (encodedData.length > maxEncodedLength) {
    throw new Error('Pasted inline image data is larger than its declared size.');
  }
}

function decodeImageData(params: string[], encodedData: string): Buffer {
  validateDeclaredSize(params, encodedData);
  if (encodedData.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error(`Pasted inline image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte limit.`);
  }

  const imageData = Buffer.from(encodedData, 'base64');
  if (imageData.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`Pasted inline image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte limit.`);
  }

  const sizeParam = getParamValue(params, 'size');
  if (sizeParam && imageData.length !== Number.parseInt(sizeParam, 10)) {
    throw new Error('Pasted inline image data does not match its declared size.');
  }
  return imageData;
}

function resolveInlineImageMimeType(params: string[], data: Buffer): string {
  const mimeType = inferMimeTypeFromMagicBytes(data);
  if (!mimeType) {
    throw new Error('Unsupported pasted inline image type. Expected PNG, JPEG, GIF, or WebP data.');
  }

  const nameMimeType = inferMimeTypeFromName(getParamValue(params, 'name'));
  if (nameMimeType && nameMimeType !== mimeType) {
    throw new Error(`Pasted inline image filename type does not match image data: ${nameMimeType} !== ${mimeType}`);
  }

  return mimeType;
}

function findTerminator(input: string, start: number): { index: number; length: number } | null {
  const belIndex = input.indexOf('\x07', start);
  const stIndex = input.indexOf('\x1B\\', start);
  if (belIndex === -1 && stIndex === -1) {
    return null;
  }
  if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
    return { index: belIndex, length: 1 };
  }
  return { index: stIndex, length: 2 };
}

export function assertPendingInlineImageWithinLimit(pendingInput: string): void {
  if (pendingInput.length > MAX_PENDING_INLINE_IMAGE_CHARS) {
    throw new Error(`Pasted inline image sequence exceeds the ${MAX_PENDING_INLINE_IMAGE_CHARS} character pending limit.`);
  }
}

export function parseInlineImageSequence(input: string, start: number): InlineImageSequence {
  if (!input.startsWith(OSC_IMAGE_PREFIX, start)) {
    throw new Error(`Expected OSC 1337 inline image sequence at offset ${start}.`);
  }

  const payloadStart = start + OSC_IMAGE_PREFIX.length;
  const terminator = findTerminator(input, payloadStart);
  if (!terminator) {
    assertPendingInlineImageWithinLimit(input.slice(start));
    return { status: 'incomplete' };
  }

  const payload = input.slice(payloadStart, terminator.index);
  const sequenceEnd = terminator.index + terminator.length;
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { status: 'passthrough', sequenceEnd };
  }

  const params = payload.slice(0, separatorIndex).split(';');
  if (!params.includes('inline=1')) {
    return { status: 'passthrough', sequenceEnd };
  }

  const encodedData = payload.slice(separatorIndex + 1);
  const imageData = decodeImageData(params, encodedData);
  return {
    status: 'image',
    image: {
      mimeType: resolveInlineImageMimeType(params, imageData),
      data: imageData,
    },
    sequenceEnd,
  };
}
