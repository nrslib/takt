export function sessionEndpoint(platform = process.platform) {
  return platform === 'win32' ? String.raw`\\.\pipe\workspace-session` : '/tmp/workspace-session.sock';
}
