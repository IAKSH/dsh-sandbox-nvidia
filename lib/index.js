/**
 * dsh-sandbox-nvidia — per-session NVIDIA device passthrough for the bwrap sandbox.
 *
 * The harness's bwrap profile mounts a fresh tmpfs on `/dev`, which hides the
 * host's NVIDIA nodes from every confined command: `nvidia-smi` cannot reach
 * NVML and PyTorch reports `cuda.is_available() == False` even on a GPU host.
 * This plugin decorates the mounted `ctx.sandbox` provider's `confine()` and,
 * for GRANTED calls only, injects `--dev-bind /dev/nvidia* …` into the bwrap
 * profile immediately after its `--dev /dev` pair.
 *
 * Design constraints (all deliberate):
 *  - Zero DSH imports: a link:-installed plugin outside the profile tree cannot
 *    resolve `@deepseek-ai/*` packages, so we talk to `ctx.sandbox` by shape.
 *  - Deny by default: an empty config grants nothing; operators opt in per
 *    session-id, per workspace root, or (explicitly) for all sessions.
 *  - Fail-safe: device enumeration happens in the unsandboxed harness process
 *    and degrades to "no devices" on any error; a non-bwrap wrap (Landlock /
 *    Seatbelt / windows-acl) is left untouched because those backends never
 *    hide `/dev`.
 *  - The decorator restores the original `confine` on unload, so HMR and
 *    plugin removal return the stock behavior without a restart.
 */
import { nvidiaDevices } from './devices.js'
import { isGranted } from './grant.js'
import { injectDevBinds } from './profile.js'

export const name = 'sandbox-nvidia'
/** Required services: only the sandbox seam we decorate. */
export const inject = ['sandbox']

/** Marker so a duplicate activation never double-wraps an already-wrapped provider. */
const WRAPPED = Symbol.for('dsh-sandbox-nvidia.wrapped')

/**
 * Config surface, validated loudly at apply time (a misconfigured security
 * plugin must fail the load, never silently widen or ignore).
 */
function validateConfig(config) {
  const cfg = {
    enabled: config.enabled ?? true,
    allSessions: config.allSessions ?? false,
    sessions: config.sessions ?? [],
    workspaces: config.workspaces ?? [],
    devices: config.devices, // optional explicit override; undefined = auto-discover
  }
  if (typeof cfg.enabled !== 'boolean') throw new TypeError('dsh-sandbox-nvidia: enabled must be a boolean')
  if (typeof cfg.allSessions !== 'boolean') throw new TypeError('dsh-sandbox-nvidia: allSessions must be a boolean')
  for (const [key, value] of [['sessions', cfg.sessions], ['workspaces', cfg.workspaces]]) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
      throw new TypeError(`dsh-sandbox-nvidia: ${key} must be an array of non-empty strings`)
    }
  }
  if (cfg.devices !== undefined
    && (!Array.isArray(cfg.devices) || cfg.devices.some(entry => typeof entry !== 'string' || !entry.startsWith('/')))) {
    throw new TypeError('dsh-sandbox-nvidia: devices must be an array of absolute paths')
  }
  return cfg
}

/** Resolve the device list for one wrap: explicit config override, else host scan. */
function resolveDevices(config) {
  if (Array.isArray(config.devices)) return config.devices
  return nvidiaDevices()
}

/**
 * Wrap one provider's `confine()` with the injection pass.
 * @param provider - the live `ctx.sandbox` service instance.
 * @param config - validated config.
 * @returns the disposer restoring the original method.
 */
function decorateSandbox(provider, config) {
  const original = provider.confine
  if (typeof original !== 'function') {
    throw new TypeError('dsh-sandbox-nvidia: ctx.sandbox has no confine() to decorate')
  }
  if (original[WRAPPED]) return () => {} // already decorated; keep the first wrapper

  const wrapped = async function confine(argv, policy, signal) {
    const result = await original.call(provider, argv, policy, signal)
    if (!isGranted(config, policy)) return result
    // The wrap already succeeded; a failed injection must not fail the call —
    // the command runs confined without GPU rather than not at all.
    try {
      const injected = injectDevBinds(result.argv, resolveDevices(config))
      return injected === undefined ? result : { ...result, argv: injected }
    } catch {
      return result
    }
  }
  defineMarker(wrapped)
  provider.confine = wrapped
  return () => {
    if (provider.confine === wrapped) provider.confine = original
  }
}

function defineMarker(fn) {
  Object.defineProperty(fn, WRAPPED, { value: true })
}

/** Apply the plugin: decorate the mounted sandbox service. */
export function apply(ctx, config = {}) {
  const cfg = validateConfig(config)
  // ctx.sandbox is guaranteed by `inject`; decorate and restore on unload so
  // HMR / disable returns stock behavior without a harness restart.
  const provider = ctx.sandbox
  ctx.effect(() => decorateSandbox(provider, cfg))
}

/**
 * Loader-facing plugin object. The DSH loader unwraps `default` before the
 * named exports (`namespace.default ?? namespace`), so the default export
 * itself must carry `name` and `inject`. Exporting only `apply` as default
 * drops the injection declaration and makes `ctx.sandbox` inaccessible with
 * "cannot get property \"sandbox\" without inject" during activation.
 */
const plugin = { name, inject, apply }

export default plugin
