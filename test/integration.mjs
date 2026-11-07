/**
 * Integration: decorate a live cordis-provided `ctx.sandbox` service with the
 * REAL vendored cordis from the harness checkout (skips when absent). Proves
 * the plugin's module contract end to end: inject-gated activation, per-call
 * grant decisions, argv injection, and restoration on unload.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const CORDIS = process.env.DSH_CORDIS_ENTRY
  ?? '/home/dsh/deepseek-harness/vendor/cordis/lib/index.js'
const hasCordis = existsSync(CORDIS)

const BWRAP_ARGV = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'bash', '-c', 'nvidia-smi']
const SID = '0193f0aa-2222-7000-8000-abcdefabcdef'

/** Minimal SandboxProvider stand-in honoring the seam's confine contract. */
function fakeProvider() {
  return {
    calls: [],
    async confine(argv, policy) {
      this.calls.push(policy)
      return { argv: [...argv], enforcement: 'full', denialSignatures: ['bwrap: '], runnerFailureRules: [] }
    },
  }
}

describe('cordis decoration', { skip: hasCordis ? false : 'vendored cordis not found' }, () => {
  it('injects for granted calls, leaves denied calls untouched, restores on unload', async () => {
    const { Context } = await import(pathToFileURL(CORDIS).href)
    const { default: plugin } = await import('../lib/index.js')
    assert.equal(plugin.name, 'sandbox-nvidia')
    assert.deepEqual(plugin.inject, ['sandbox'])
    const ctx = new Context()
    const provider = fakeProvider()
    ctx.provide('sandbox', provider)
    const originalConfine = provider.confine

    const fiber = await ctx.plugin(plugin, { sessions: [SID], workspaces: ['/home/dsh/ml'], devices: ['/dev/nvidia0', '/dev/nvidiactl'] })

    // Denied session: argv passes through byte-identical.
    const denied = await ctx.sandbox.confine(BWRAP_ARGV, { mode: 'read-only', workspaceRoot: '/', sessionId: 'not-granted' })
    assert.deepEqual(denied.argv, BWRAP_ARGV)

    // Granted session: --dev-bind lands directly after --dev /dev.
    const granted = await ctx.sandbox.confine(BWRAP_ARGV, { mode: 'read-only', workspaceRoot: '/', sessionId: SID })
    const devIdx = granted.argv.indexOf('--dev')
    assert.equal(granted.argv[devIdx + 1], '/dev')
    assert.equal(granted.argv[devIdx + 2], '--dev-bind')
    assert.equal(granted.argv[devIdx + 3], '/dev/nvidia0') // explicit config override
    assert.equal(granted.argv.at(-1), 'nvidia-smi') // command section untouched

    // Grant by workspace root (boundary-safe).
    const byWorkspace = await ctx.sandbox.confine(BWRAP_ARGV, { mode: 'workspace-write', workspaceRoot: '/home/dsh/ml/sub', sessionId: 'other' })
    assert.ok(byWorkspace.argv.includes('--dev-bind'))

    await fiber.dispose()
    // After unload the original method is restored: identical argv again.
    assert.equal(provider.confine, originalConfine)
    const restored = await provider.confine(BWRAP_ARGV, { mode: 'read-only', workspaceRoot: '/', sessionId: SID })
    assert.deepEqual(restored.argv, BWRAP_ARGV)
    await ctx.fiber.dispose()
  })

  it('denies everything with an empty config (deny by default)', async () => {
    const { Context } = await import(pathToFileURL(CORDIS).href)
    const { default: plugin } = await import('../lib/index.js')
    const ctx = new Context()
    const provider = fakeProvider()
    ctx.provide('sandbox', provider)
    const fiber = await ctx.plugin(plugin, { devices: ['/dev/nvidia0'] })
    const result = await ctx.sandbox.confine(BWRAP_ARGV, { mode: 'read-only', workspaceRoot: '/', sessionId: SID })
    assert.deepEqual(result.argv, BWRAP_ARGV)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a malformed config at load time', async () => {
    const { Context } = await import(pathToFileURL(CORDIS).href)
    const { default: plugin } = await import('../lib/index.js')
    const ctx = new Context()
    ctx.provide('sandbox', fakeProvider())
    await assert.rejects(
      () => Promise.resolve(ctx.plugin(plugin, { sessions: 'oops' })),
      /sessions must be an array/,
    )
    await ctx.fiber.dispose()
  })
})
