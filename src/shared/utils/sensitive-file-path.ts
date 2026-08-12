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

const SENSITIVE_PURPOSE_FILE_NAME_PATTERN = /^(?:(?:prod|production)[-_]secrets?|credentials?|secrets?|service[-_]accounts?)(?:\..+)?$/;
const SENSITIVE_AUTH_CONFIG_FILE_NAME_PATTERN = /^(?:auth(?:orization)?|tokens?)\.(?:conf(?:ig)?|ini|json|toml|txt|ya?ml)$/;

export function isSensitiveProjectFilePath(relativePath: string): boolean {
  const lowerSegments = relativePath.split('/').map((segment) => segment.toLowerCase());
  const lowerFileName = lowerSegments.at(-1);
  if (lowerFileName === undefined) {
    return true;
  }
  return lowerSegments.some((segment) => SENSITIVE_PROJECT_DIRECTORY_NAMES.has(segment))
    || lowerFileName.startsWith('.env')
    || SENSITIVE_PROJECT_FILE_NAMES.has(lowerFileName)
    || SENSITIVE_PURPOSE_FILE_NAME_PATTERN.test(lowerFileName)
    || SENSITIVE_AUTH_CONFIG_FILE_NAME_PATTERN.test(lowerFileName)
    || SENSITIVE_PROJECT_FILE_EXTENSIONS.some((extension) => lowerFileName.endsWith(extension));
}
