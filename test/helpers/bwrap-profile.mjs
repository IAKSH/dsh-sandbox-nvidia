/** Mirror of the harness's bwrap profile builder (read-only + workspace-write
 *  shapes) so the e2e exercises the exact argv topology the provider emits.
 *  Kept in-repo because the real builder lives in @deepseek-ai/dsh-sandbox-local
 *  which a zero-dependency plugin cannot import. */
export function bwrapProfileArgs(policy) {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return ['bwrap', ...args]
}
