/**
 * Host NVIDIA device-node discovery. The enumeration runs in the UNSANDBOXED
 * harness process (where `/dev` is the real devtmpfs), so it always sees the
 * true device set even though confined children cannot.
 */
import { readdirSync, statSync } from 'node:fs'

/**
 * Device names the driver exposes under `/dev`: GPUs, the control device
 * (`nvidiactl`, required by NVML even when a GPU node is present), UVM,
 * modeset, persistence, and capabilities.
 */
const NVIDIA_NAME = /^nvidia(\d+|ctl|-uvm|-uvm-tools|-modeset|-persistctl|-caps.*)$/u

/**
 * List the NVIDIA device nodes present under `devDir`.
 *
 * Fail-safe by design: an unreadable directory or a node that vanishes between
 * readdir and stat yields a SHORTER list, never a throw — a missing node must
 * degrade to "no GPU for this wrap", not break every confined command. Nodes
 * that disappear between this enumeration and the child's bwrap start remain
 * the one accepted TOCTOU window; bwrap then fails that single wrap, which the
 * provider classifies as a runner failure rather than silently unconfined.
 *
 * @param devDir - the device directory to scan (defaults to the host `/dev`).
 * @returns sorted absolute node paths; empty when the host has no NVIDIA driver.
 */
export function nvidiaDevices(devDir = '/dev') {
  let entries
  try {
    entries = readdirSync(devDir)
  } catch {
    return []
  }
  const nodes = []
  for (const name of entries) {
    if (!NVIDIA_NAME.test(name)) continue
    const path = `${devDir}/${name}`
    try {
      // Character device or the nvidia-caps directory; anything else is an
      // impostor sharing the prefix (a regular file named nvidia0) and is skipped.
      const stats = statSync(path)
      if (stats.isDirectory() || stats.isCharacterDevice()) nodes.push(path)
    } catch {
      // Raced away between readdir and stat — drop it.
    }
  }
  return nodes.sort()
}
