const SENSITIVE_PROJECT_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.vault-token',
  'application_default_credentials.json',
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
  '.tfvars',
] as const;

const SENSITIVE_PROJECT_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
]);

const SENSITIVE_CONFIG_DATA_FILE_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'config',
  'env',
  'ini',
  'json',
  'properties',
  'toml',
  'txt',
  'yaml',
  'yml',
]);

const SENSITIVE_PURPOSE_BASENAME_PATTERN = /(?:^|[._-])(?:auth(?:orization)?|credentials?|secrets?|service[-_]accounts?|tokens?)(?:[._-]|$)/;
const SENSITIVE_EXTENSIONLESS_FILE_NAME_PATTERN = /(?:^|[._-])secrets?(?:[._-]|$)|^(?:credentials?|service[-_]accounts?)$/;

function hasSensitivePurposeFileName(fileName: string): boolean {
  const extensionSeparator = fileName.lastIndexOf('.');
  if (extensionSeparator < 0) {
    return SENSITIVE_EXTENSIONLESS_FILE_NAME_PATTERN.test(fileName);
  }
  const extension = fileName.slice(extensionSeparator + 1);
  if (!SENSITIVE_CONFIG_DATA_FILE_EXTENSIONS.has(extension)) return false;
  return SENSITIVE_PURPOSE_BASENAME_PATTERN.test(fileName.slice(0, extensionSeparator));
}

export function isSensitiveProjectFilePath(relativePath: string): boolean {
  const lowerSegments = relativePath.split('/').map((segment) => segment.toLowerCase());
  const lowerFileName = lowerSegments.at(-1)!;
  return lowerSegments.some((segment) => SENSITIVE_PROJECT_DIRECTORY_NAMES.has(segment))
    || lowerFileName.startsWith('.env')
    || SENSITIVE_PROJECT_FILE_NAMES.has(lowerFileName)
    || hasSensitivePurposeFileName(lowerFileName)
    || SENSITIVE_PROJECT_FILE_EXTENSIONS.some((extension) => lowerFileName.endsWith(extension));
}
