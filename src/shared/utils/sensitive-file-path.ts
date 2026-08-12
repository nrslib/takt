const SENSITIVE_PROJECT_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

const SENSITIVE_PROJECT_FILE_EXTENSIONS = [
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
] as const;

const SENSITIVE_PROJECT_DIRECTORY_NAMES = new Set([
  '.aws',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
]);

export function isSensitiveProjectFilePath(relativePath: string): boolean {
  const lowerSegments = relativePath.split('/').map((segment) => segment.toLowerCase());
  const lowerFileName = lowerSegments.at(-1);
  if (lowerFileName === undefined) {
    return true;
  }
  return lowerSegments.some((segment) => SENSITIVE_PROJECT_DIRECTORY_NAMES.has(segment))
    || lowerFileName.startsWith('.env')
    || SENSITIVE_PROJECT_FILE_NAMES.has(lowerFileName)
    || SENSITIVE_PROJECT_FILE_EXTENSIONS.some((extension) => lowerFileName.endsWith(extension));
}
