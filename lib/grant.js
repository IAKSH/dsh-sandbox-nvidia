/**
 * Per-call GPU grant decision. Pure and policy-shaped: it consumes the same
 * `SandboxPolicy` fields (`sessionId`, `workspaceRoot`) the provider's
 * `confine()` receives, so the decision is expressible without any DSH import.
 */

/** Reject ambiguous prefixes: `/home/dsh/ml` must not grant `/home/dsh/malicious`. */
function underRoot(root, allowed) {
  if (root === allowed) return true
  const prefix = allowed.endsWith('/') ? allowed : `${allowed}/`
  return root.startsWith(prefix)
}

/**
 * Decide whether one confined call may receive NVIDIA device passthrough.
 *
 * Deny by default — an empty config grants nothing. A session is granted when
 * it matches ANY configured allow-list dimension:
 *  1. `sessions` — exact SessionId match (opaque session identity).
 *  2. `workspaces` — the policy's workspaceRoot sits under an allowed root.
 *  3. `allSessions` — explicit operator opt-in for every session.
 *
 * @param config - validated plugin config (may be partially filled).
 * @param policy - the per-call sandbox policy the provider received.
 * @returns `true` when device nodes should be injected for this call.
 */
export function isGranted(config, policy) {
  if (config.enabled === false) return false
  if (config.allSessions === true) return true
  if (Array.isArray(config.sessions) && policy.sessionId !== undefined) {
    const sessionId = String(policy.sessionId)
    if (config.sessions.includes(sessionId)) return true
  }
  if (Array.isArray(config.workspaces) && typeof policy.workspaceRoot === 'string') {
    for (const allowed of config.workspaces) {
      if (underRoot(policy.workspaceRoot, allowed)) return true
    }
  }
  return false
}
