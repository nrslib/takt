/** Git invokes this static helper with `get`, `store`, or `erase`. Credentials stay in the child environment. */
export function remoteGitCredentialHelper(): string {
  const program = `if(process.argv[1]==='get'){const fs=require('node:fs');const fields=Object.fromEntries(fs.readFileSync(0,'utf8').trim().split('\\n').map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));const url=new URL(process.env.TAKT_REMOTE_GIT_ORIGIN);if(fields.protocol===url.protocol.slice(0,-1)&&fields.host===url.host){process.stdout.write('username=x-access-token\\npassword='+process.env.TAKT_REMOTE_GIT_TOKEN+'\\n\\n')}}`;
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return `!${quote(process.execPath)} -e ${quote(program)}`;
}
