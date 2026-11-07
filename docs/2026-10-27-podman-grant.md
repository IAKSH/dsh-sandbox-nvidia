# 2026-10-27：podman 容器内沙箱 CUDA 不可用的根因与修复

- **影响**：`workspace-write` / `read-only` 模式下 `nvidia-smi` 报
  *NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver*，
  `torch.cuda.is_available()` 为 `False`；`danger-full-access` 模式一切正常。
- **结论**：**插件代码没有 bug**，根因是 profile 授权配置未覆盖本会话的
  workspace，被本插件的 deny-by-default 设计正确地拒绝了。
- **修复**：仅一处配置改动 —— `~/.dsh/profiles/web/cordis.patch.yml` 的
  `sandbox-nvidia` 条目 `workspaces` 增加 `- /home/dsh`。
- **验证**：25/25 测试通过，真实 `workspace-write` 沙箱内
  `nvidia-smi` 与 PyTorch CUDA 均正常，同时文件沙箱未被削弱。

## 1. 现象与排查路径

排查顺序是先证明"机制可用"，再证明"配置是否授权"：

| 检查 | 结果 |
|---|---|
| 插件安装 / 加载 | ✅ link 安装，`plugin_manager list_plugins` 显示 `enabled:true, fiberPhase:active` |
| 自带测试 | ✅ 20/20（含真实 bwrap e2e） |
| 注入机制在本容器可用 | ✅ 手工构造含 `--dev-bind` 的真实 bwrap，`nvidia-smi -L` 输出 GPU 0 |
| 装饰器是否落到真实服务上 | ✅ 真实 cordis + 真实 `LocalSandboxProvider` 下确实拦到 `confine()` |
| **线上授权配置** | ❌ `workspaces` 只列了 `/home/dsh/repos`、`/mnt/hdd/repos`、`/home/dsh/deepseek-harness` |

本会话 workspace 是 **`/home/dsh`**，不在上述任何一个之下 ——
`grant.js` 的 `isGranted()` 返回 `false`，于是不注入 `--dev-bind`。

链路：

```
workspace=/home/dsh 不在授权表
  → isGranted() = false，不注入 --dev-bind
  → harness profile 的 `--dev /dev` 挂载全新 tmpfs，遮蔽 /dev/nvidia*
  → nvidia-smi 无法与驱动通信 (exit 9)，torch.cuda = False
```

## 2. 失败假设的排除过程

排查中验证并**排除**了以下怀疑，记录在此以免重复排查：

1. **podman 的 bwrap shim 与注入不兼容** —— 否。
   `/usr/local/sbin/bwrap` 是 Python shim：容器内自动去掉 `--unshare-pid`、
   加 `--unshare-user`。与 `--dev-bind` 注入完全兼容（实测通过）。
2. **设备节点发现失败** —— 否。`devices.js` 稳定发现 5 个节点：
   `/dev/nvidia-caps`、`/dev/nvidia-uvm`、`/dev/nvidia-uvm-tools`、
   `/dev/nvidia0`、`/dev/nvidiactl`。
3. **`--dev-bind` 放错位置被 tmpfs 遮蔽** —— 否。注入点紧跟 `--dev /dev`，
   符合 bwrap 的顺序语义。
4. **注入导致文件沙箱变松** —— 否。修复后实测：`/etc` 仍 `Read-only file system`，
   workspace 仍可写，`/` 仍是 `ro` overlay。
5. **不存在的 workspace 目录导致 bwrap 失败** —— 与插件无关。
   A/B 对照（注入 vs 不注入）失败完全相同，失败点是 harness 自己的
   `--bind <root> <root>`，根因是目录缺失（早前被删的
   `/home/dsh/plugin-search`、`/home/dsh/hardware-check`）。

### 排查中犯的一个错误（供借鉴）

早期验证脚本把**已预包装的 bwrap argv** 传给 `confine()`，而 provider 会
再包一层，产生**嵌套 bwrap**：外层带 `--dev-bind`，真正执行命令的内层没有，
于是 `nvidia-smi` exit 9 —— 一度被误判为插件缺陷。

真实调用方（`bash-sandbox`）传的是**普通命令 argv** `['bash', '-c', cmd]`，
由 provider 包裹一次。任何对 `confine()` 的验证都必须遵守这一契约。

## 3. 修复内容

`~/.dsh/profiles/web/cordis.patch.yml`（**该文件在本仓库之外**，属 profile 配置）：

```yaml
- id: sandbox-nvidia
  name: dsh-sandbox-nvidia
  config:
    workspaces:
      - /home/dsh            # ← 新增：本容器的会话 workspace 根
      - /home/dsh/repos
      - /mnt/hdd/repos       # 宿主拼写，容器内另有 /home/dsh/repos
      - /home/dsh/deepseek-harness
```

选择"加 `/home/dsh`"而非 `allSessions: true` 的原因：授权按**路径边界**匹配，
`/home/dsh` 覆盖本会话及其全部子 workspace，但**不会**误授给
`/home/dsh-evil` 这类兄弟前缀（`grant.js` 的 `underRoot()` 保证），
比 `allSessions` 保留更细的边界。

> 因为改动在仓库外，**首次 commit 无法包含它**。它靠 profile 配置本身持久化；
> 本文档即为其记录。回归由 `test/verify-grant.mjs` 直接读取线上 patch 来看守。

## 4. 生效与验证

改动后 `cordis.patch.yml` 会被 HMR 监听（`hmr/src/index.ts` 的
`patchFiles = [profile.patchPath, …]` → `watchConfig`），本次亦随 harness 重启加载。

```bash
# 1. 官方组合配置确认
cd /home/dsh/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config | grep -A8 'dsh-sandbox-nvidia, patched'

# 2. 插件测试（25 项：20 单测/集成 + 5 线上授权回归）
cd /home/dsh/dsh-sandbox-nvidia && node --test "test/**/*.mjs"

# 3. 真实沙箱内验证（会话须处于 workspace-write / read-only）
nvidia-smi -L
python3 -c 'import torch; print(torch.cuda.is_available())'
```

真实 `workspace-write` 沙箱下的实测结果：

```
$ nvidia-smi -L
GPU 0: NVIDIA GeForce RTX 3070 (UUID: GPU-1fb4658-…)

$ python3 -c 'import torch; …'
torch 2.11.0+cu128 / cuda available: True / device: NVIDIA GeForce RTX 3070
GPU 矩阵乘 20×(4096²) 0.286 s，分配 72 MiB
```

抓取到的父进程 bwrap 实况命令行（`--dev-bind` 紧跟 `--dev /dev`）：

```
bwrap --unshare-user --ro-bind / / --dev /dev
      --dev-bind /dev/nvidia-caps /dev/nvidia-caps
      --dev-bind /dev/nvidia-uvm  /dev/nvidia-uvm
      --dev-bind /dev/nvidia-uvm-tools /dev/nvidia-uvm-tools
      --dev-bind /dev/nvidia0     /dev/nvidia0
      --dev-bind /dev/nvidiactl   /dev/nvidiactl
      --proc /proc --die-with-parent --tmpfs /tmp --bind /home/dsh /home/dsh -- bash -c …
```

## 5. 环境备注

- **`danger-full-access` 下看不到本插件效果属正常**：`bash-sandbox` 在该模式
  直接跳过 `confine()`（`packages/shell/bash-sandbox/src/index.ts`），插件不会被调用。
- **`nvcc` 未安装**：CUDA 12.8 运行时由 pip wheel 提供，训练/推理足够；
  编译 CUDA 扩展（`torch.utils.cpp_extension`）才需要额外安装 CUDA Toolkit。
- **`/mnt/hdd` 在本容器中时有时无**（宿主路径，非稳定挂载）；其对应的容器内
  路径是 `/home/dsh/repos`。
- **设备属主为 `nobody:nobody`、权限 `666`**，容器内任何用户均可打开。

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `lib/grant.js` | 逐次调用的授权判定（`sessions` / `workspaces` / `allSessions`） |
| `lib/profile.js` | bwrap argv 手术：在 `--dev /dev` 后插入 `--dev-bind` |
| `lib/devices.js` | 在**未受沙箱**的 harness 进程里发现 `/dev/nvidia*` |
| `lib/index.js` | cordis 装饰器，unload 时恢复原 `confine` |
| `test/verify-grant.mjs` | 线上授权回归：读真实 patch + 真实 provider + 真实 bwrap |
| `test/bwrap-e2e.mjs` | 注入机制 e2e（与授权无关，CI 上可独立绿） |
| `~/.dsh/profiles/web/cordis.patch.yml` | **修复所在**（仓库外的 profile 配置） |
