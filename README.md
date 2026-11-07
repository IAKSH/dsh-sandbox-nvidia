# dsh-sandbox-nvidia

**Per-session NVIDIA device passthrough for the DeepSeek Harness bwrap sandbox.**

The harness's bwrap profile (`@deepseek-ai/dsh-sandbox-local`) mounts a fresh
tmpfs on `/dev`, which hides the host's NVIDIA nodes from every confined
command. On a GPU host this means `nvidia-smi` reports "couldn't communicate
with the driver" and PyTorch reports `cuda.is_available() == False` inside the
sandbox — even though the driver and GPU are perfectly healthy. This plugin
fixes that **without weakening the file sandbox**: it decorates the mounted
`ctx.sandbox` provider and injects `--dev-bind /dev/nvidia* …` into the bwrap
profile, but only for calls a policy allow-list grants.

## How it works

```
confined call ─▶ ctx.sandbox.confine(argv, policy)
                    │
                    ├─ original wrap (bwrap / Landlock / Seatbelt / windows-acl)
                    │
                    └─ plugin decorator:
                         granted(policy)?  ── no ──▶ return argv unchanged
                                │ yes
                         inject --dev-bind <node> <node> …
                         immediately AFTER the profile's `--dev /dev` pair
                         (bwrap applies mounts in order; a bind before the
                         fresh /dev tmpfs would be shadowed)
```

- **Deny by default.** An empty config grants nothing. Opt in per session id,
  per workspace root, or (explicitly) for every session.
- **Fail-safe.** Device discovery runs in the *unsandboxed* harness process and
  degrades to "no devices" on any error; a non-bwrap wrap is left untouched
  because Landlock/Seatbelt/windows-acl never hide `/dev`.
- **Nothing else widens.** The child is still confined: read-only stays
  read-only, workspace-write still only writes the workspace. Verified by e2e.
- **Zero DSH imports**, so it installs cleanly as an external bundle.
- Restores the original `confine` on unload — disable or HMR needs no restart.

## Install

From a harness session (Standard/Creator presets have `plugin_manager`):

```
plugin_manager  action: install_bundle  target: /home/dsh/dsh-sandbox-nvidia
```

Then enable it in your profile's `cordis.patch.yml` (the shipped bundle patch
inserts it **disabled-by-default-config** — nothing is granted until you
configure it):

```yaml
- id: sandbox-nvidia
  name: dsh-sandbox-nvidia
  config:
    workspaces:          # grant by workspace root (boundary-safe prefix)
      - /home/dsh/ml
    # sessions:          # or grant by opaque session id
    #   - 0193f0aa-…
    # allSessions: true  # escape hatch: every session gets the GPU
    # devices:           # pin nodes instead of auto-discovering /dev/nvidia*
    #   - /dev/nvidia0
    #   - /dev/nvidiactl
    #   - /dev/nvidia-uvm
```

With HMR the change applies immediately; otherwise restart the session.

## Verify

Inside a granted session:

```bash
nvidia-smi                                     # works inside the sandbox now
python -c 'import torch; print(torch.cuda.is_available())'   # True
ls -l /dev/nvidia*                             # nodes are real device files
```

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch; `false` makes the decorator a no-op. |
| `sessions` | string[] | `[]` | SessionIds granted GPU access. |
| `workspaces` | string[] | `[]` | Workspace roots; a policy `workspaceRoot` equal to or **under** one of these is granted (`/home/dsh/ml` does not grant `/home/dsh/malicious`). |
| `allSessions` | boolean | `false` | Grant every session. Explicit opt-in. |
| `devices` | string[] | auto | Pin exact node paths instead of scanning `/dev/nvidia*`. |

A malformed config **fails the plugin load loudly** — a misconfigured security
plugin must never silently widen or silently ignore.

> **Deny by default cuts both ways.** An allow-list that omits the workspace a
> session actually runs under yields a healthy-looking plugin that inject
> nothing — `nvidia-smi` then reports it cannot reach the driver, exactly as if
> the GPU were missing. Check `workspaces` against the session's real
> `workspaceRoot` first; `test/verify-grant.mjs` asserts this against the live
> profile. Post-mortem of one such outage:
> [`docs/2026-10-27-podman-grant.md`](docs/2026-10-27-podman-grant.md).

## Security notes

- The grant is evaluated **per call** from the same `SandboxPolicy` the
  provider receives (`sessionId`, `workspaceRoot`), so an escalated retry or a
  forked session is re-evaluated, not grandfathered.
- Device passthrough exposes the GPU/驱动 ioctl surface to granted commands —
  that is the point — but grants **no** additional filesystem, network, or
  process visibility. The file sandbox's enforcement is byte-identical.
- Non-bwrap backends (Landlock fallback, Seatbelt, windows-acl) are never
  modified: they don't hide `/dev`, so the nodes are already reachable there.

## Tests

```bash
node --test "test/**/*.mjs"   # 25 tests: unit + real-cordis decoration + real-bwrap e2e + live-profile grant
```

- `selftest.mjs` — pure-function unit tests (argv surgery, discovery, grants).
- `integration.mjs` — decorates a live cordis-provided `ctx.sandbox` using the
  harness's vendored cordis; verifies grant/deny, injection, and restoration.
- `bwrap-e2e.mjs` — runs a **real bwrap** with the injected profile and proves
  the node becomes visible while the file sandbox still denies writes. Skips
  when bwrap/user namespaces are unavailable.
- `verify-grant.mjs` — reads the **live** profile `cordis.patch.yml`, applies it
  through the real provider, and asserts the session workspace is granted
  (`--dev-bind` present, `nvidia-smi` works inside the wrap) while an unrelated
  root stays denied. Skips without the harness checkout, patch, bwrap, or GPU.

## License

[MIT](LICENSE) © 2026 IAKSH — same license as the DeepSeek Harness it plugs into.
