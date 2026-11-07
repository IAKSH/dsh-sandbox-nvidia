/**
 * Pure bwrap-argv surgery: inject `--dev-bind` passes for NVIDIA device nodes
 * into an already-wrapped argv. No DSH imports, no I/O — unit-testable with
 * plain Node.
 */

/** The bwrap profile signature every confined Linux wrap carries: `--dev /dev`. */
const DEV_FLAG = '--dev'
const DEV_PATH = '/dev'
/** bwrap bind options whose operand triple is `flag <source> <target>`. */
const BIND_FLAGS = new Set(['--bind', '--dev-bind', '--ro-bind', '--rbind'])

/**
 * Index of the `--dev /dev` pair's path operand, or -1 when the argv is not a
 * bwrap wrap (Landlock launcher, Seatbelt, windows-acl, or a foreign runner).
 */
export function bwrapDevIndex(argv) {
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === DEV_FLAG && argv[i + 1] === DEV_PATH) return i + 1
  }
  return -1
}

/** Targets already bound in the profile section (before the `--` separator). */
function boundTargets(argv, profileEnd) {
  const targets = new Set()
  for (let i = 0; i < profileEnd; i++) {
    if (!BIND_FLAGS.has(argv[i])) continue
    if (i + 2 < profileEnd) targets.add(argv[i + 2])
    i += 2
  }
  return targets
}

/**
 * Insert `--dev-bind <node> <node>` for each device immediately after the
 * profile's `--dev /dev` pair — bwrap applies operations in order, so a bind
 * landing before the fresh `/dev` tmpfs would be shadowed by it.
 *
 * Returns a NEW argv, or `undefined` when nothing should change: the argv is
 * not a bwrap wrap (other backends never hide `/dev`, so devices are already
 * reachable there), or every device is already bound (idempotence — a repeated
 * wrap must not duplicate operands).
 *
 * @param argv - the confined argv as returned by the sandbox provider.
 * @param devices - absolute device-node paths to pass through.
 * @returns the injected argv, or undefined to keep the original.
 */
export function injectDevBinds(argv, devices) {
  if (devices.length === 0) return undefined
  const devIdx = bwrapDevIndex(argv)
  if (devIdx === -1) return undefined
  // Profile args never contain a bare `--`; the first one is the separator.
  const separator = argv.indexOf('--')
  const profileEnd = separator === -1 ? argv.length : separator
  const bound = boundTargets(argv, profileEnd)
  const fresh = devices.filter(device => !bound.has(device))
  if (fresh.length === 0) return undefined
  const binds = fresh.flatMap(device => ['--dev-bind', device, device])
  return [...argv.slice(0, devIdx + 1), ...binds, ...argv.slice(devIdx + 1)]
}
