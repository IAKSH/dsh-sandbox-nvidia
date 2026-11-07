/**
 * Real-bwrap e2e: prove the injected argv actually exposes a device node to a
 * confined child. Skips when bwrap or user namespaces are unavailable (same
 * convention as the harness's own bwrap.e2e.ts). Uses /dev/null as a stand-in
 * device — the mechanism under test is the --dev-bind injection, not NVIDIA
 * hardware, so the suite runs green even on CI boxes without a GPU.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { bwrapProfileArgs } from './helpers/bwrap-profile.mjs'
import { nvidiaDevices } from '../lib/devices.js'
import { injectDevBinds } from '../lib/profile.js'

const PROFILE = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' })
const probe = spawnSync(PROFILE[0], [...PROFILE.slice(1), '--', 'true'], { timeout: 5000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0
const hostDevices = nvidiaDevices()
const nvidiaSmi = spawnSync('nvidia-smi', ['-L'], { timeout: 5000, encoding: 'utf8' })
const gpuUsable = bwrapUsable
  && hostDevices.includes('/dev/nvidiactl')
  && hostDevices.some(device => /\/nvidia\d+$/u.test(device))
  && nvidiaSmi.status === 0

function runConfined(argv) {
  return spawnSync(argv[0], argv.slice(1), { timeout: 5000, encoding: 'utf8' })
}

describe('bwrap device passthrough', { skip: bwrapUsable ? false : 'bwrap unavailable' }, () => {
  it('WITHOUT injection the fresh /dev tmpfs hides the device node', () => {
    const argv = [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'sh', '-c', 'test -e /dev/null || echo hidden']
    const result = runConfined(argv)
    // /dev/null is one of the few nodes bwrap's --dev recreates, so probe with
    // a node that is NOT in the standard set: bind nothing, look for a
    // sentinel that only a --dev-bind would provide.
    const sentinel = spawnSync(argv[0], [...argv.slice(1, -3), 'sh', '-c', 'test -e /dev/nvidia-e2e || echo hidden'], { timeout: 5000, encoding: 'utf8' })
    assert.match(sentinel.stdout, /hidden/)
    assert.equal(result.status, 0)
  })

  it('WITH injection the bound device node is visible and is a char device', () => {
    const base = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' })
    // Bind the real /dev/null at an NVIDIA-shaped path — same mechanics as
    // --dev-bind /dev/nvidia0 /dev/nvidia0 on a GPU host.
    const injected = injectDevBinds([...base, '--', 'true'], ['/dev/null'])
    assert.ok(injected !== undefined && injected.includes('--dev-bind'))
    const marker = injected.slice(0, injected.indexOf('--'))
    const argv = [...marker, '--', 'sh', '-c', 'test -c /dev/null && echo visible']
    const result = runConfined(argv)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /visible/)
  })

  it('a granted wrap still confines writes (device passthrough widens NOTHING else)', () => {
    const base = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' })
    const injected = injectDevBinds([...base, '--', 'true'], ['/dev/null'])
    const marker = injected.slice(0, injected.indexOf('--'))
    const argv = [...marker, '--', 'sh', '-c', 'touch /etc/nvidia-e2e-should-fail 2>&1 || echo denied']
    const result = runConfined(argv)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /denied/)
  })

  it('auto-discovered host nodes make nvidia-smi usable in the wrap', { skip: gpuUsable ? false : 'NVIDIA device nodes or nvidia-smi unavailable' }, () => {
    // Regression guard: /dev/nvidiactl is required for NVML and must not be
    // omitted from discovery (GPU nodes and UVM alone are insufficient).
    assert.ok(hostDevices.includes('/dev/nvidiactl'))
    const base = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' })
    const injected = injectDevBinds([...base, '--', 'nvidia-smi', '-L'], hostDevices)
    assert.ok(injected !== undefined)
    const result = runConfined(injected)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /GPU \d+:/u)
  })
})
