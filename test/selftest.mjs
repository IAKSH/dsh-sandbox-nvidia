/**
 * Plain-Node selftest (node --test test/). No DSH imports, no build step:
 * every lib module is dependency-free ESM, so the suite runs against source.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { bwrapDevIndex, injectDevBinds } from '../lib/profile.js'
import { nvidiaDevices } from '../lib/devices.js'
import { isGranted } from '../lib/grant.js'

const RW = ['/home/dsh/ml/train.py', '/home/dsh/ml/src', '/home/dsh/ml/out']
const BWRAP_RO = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'bash', '-c', 'nvidia-smi']
const BWRAP_RW = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', '/home/dsh/ml', '/home/dsh/ml', '--', 'python', 'train.py']
const LANDLOCK = ['/home/dsh/.dsh/landlock-run', '--read-only', '/:/home/dsh/ml:/rw', '--', 'bash', '-c', 'nvidia-smi']

describe('profile.js', () => {
  it('detects the bwrap --dev /dev pair and ignores other backends', () => {
    assert.equal(bwrapDevIndex(BWRAP_RO), 5)
    assert.equal(bwrapDevIndex(LANDLOCK), -1)
  })

  it('inserts device binds immediately after --dev /dev', () => {
    const out = injectDevBinds(BWRAP_RO, ['/dev/nvidia0', '/dev/nvidiactl'])
    assert.deepEqual(out.slice(0, 8), ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--dev-bind', '/dev/nvidia0'])
    assert.equal(out[8], '/dev/nvidia0')
    assert.deepEqual(out.slice(9, 11), ['--dev-bind', '/dev/nvidiactl'])
    // command section untouched
    assert.deepEqual(out.slice(-4), ['--', 'bash', '-c', 'nvidia-smi'])
  })

  it('is idempotent across repeated wraps', () => {
    const once = injectDevBinds(BWRAP_RO, ['/dev/nvidia0'])
    const twice = injectDevBinds(once, ['/dev/nvidia0', '/dev/nvidiactl'])
    assert.equal(twice.filter(a => a === '/dev/nvidia0').length, 2) // src+target pair, not duplicated
    assert.equal(twice.filter(a => a === '--dev-bind').length, 2)
  })

  it('returns undefined for non-bwrap argv and empty device lists', () => {
    assert.equal(injectDevBinds(LANDLOCK, ['/dev/nvidia0']), undefined)
    assert.equal(injectDevBinds(BWRAP_RO, []), undefined)
  })

  it('handles workspace-write profiles with trailing binds', () => {
    const out = injectDevBinds(BWRAP_RW, ['/dev/nvidia0'])
    assert.ok(out.includes('--dev-bind'))
    assert.deepEqual(out.slice(-2), ['python', 'train.py'])
  })
})

describe('devices.js', () => {
  const dirs = []
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'nv-fix-'))
    dirs.push(dir)
    return dir
  }
  after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

  it('returns [] on an unreadable directory instead of throwing', () => {
    assert.deepEqual(nvidiaDevices('/nonexistent-dev-dir'), [])
  })

  it('accepts only character devices and the caps directory, sorted', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'nvidia-caps'))
    symlinkSync('/dev/null', join(dir, 'nvidia0')) // resolves to a char device: accepted
    symlinkSync('/dev/null', join(dir, 'nvidiactl')) // control node: required for NVML
    writeFileSync(join(dir, 'nvidia1'), 'impostor') // regular file sharing the prefix: skipped
    // We cannot mknod char devices unprivileged, so the live-host scan below
    // exercises the real positive path.
    assert.deepEqual(nvidiaDevices(dir), [`${dir}/nvidia-caps`, `${dir}/nvidia0`, `${dir}/nvidiactl`])
  })

  it('finds real nodes on a live host or degrades to []', () => {
    const nodes = nvidiaDevices()
    assert.ok(Array.isArray(nodes))
    for (const node of nodes) assert.match(node, /^\/dev\/nvidia/)
  })
})

describe('grant.js', () => {
  const sid = '0193f0aa-1111-7000-8000-abcdefabcdef'

  it('denies by default with an empty config', () => {
    assert.equal(isGranted({}, { sessionId: sid, workspaceRoot: '/home/dsh/ml' }), false)
  })

  it('grants by exact session id', () => {
    const cfg = { sessions: [sid] }
    assert.equal(isGranted(cfg, { sessionId: sid }), true)
    assert.equal(isGranted(cfg, { sessionId: 'other' }), false)
  })

  it('grants by workspace prefix with boundary safety', () => {
    const cfg = { workspaces: ['/home/dsh/ml'] }
    assert.equal(isGranted(cfg, { workspaceRoot: '/home/dsh/ml' }), true)
    assert.equal(isGranted(cfg, { workspaceRoot: '/home/dsh/ml/sub' }), true)
    assert.equal(isGranted(cfg, { workspaceRoot: '/home/dsh/malicious' }), false)
  })

  it('honors enabled=false over everything', () => {
    assert.equal(isGranted({ enabled: false, allSessions: true }, {}), false)
  })

  it('grants all sessions only under the explicit opt-in', () => {
    assert.equal(isGranted({ allSessions: true }, {}), true)
  })
})
