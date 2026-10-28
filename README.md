# EffortKeeper · 推理档位记忆器

[中文](README.md) | [English](README.en.md)

[![CI](https://github.com/ChimeSky/dsh-effort-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/ChimeSky/dsh-effort-keeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](https://github.com/topics/dsh-plugin)

EffortKeeper 是一个独立安装的 DeepSeek Harness（DSH）Host 插件，用来解决一个具体问题：

> 为 Claude Sonnet 5.5 选择了 High，切到 Gemini 后再切回来，DSH 却显示 Default。

插件按 **Provider ID + Model ID** 记住每个模型最后一次由用户明确选择的推理档位，并在切回该模型时用**同一次原生选择调用**恢复。你仍然使用 DSH 原生的模型选择器和推理档位菜单，不需要打开额外页面或点击保存。

- 项目名：`dsh-effort-keeper`
- 中文名：推理档位记忆器
- 当前版本：`1.0.5`
- 已验证运行时：DSH Desktop `0.2.1-rc.3`（Windows）
- 依赖：无（只使用 Node 标准库和 DSH 已提供的服务）

---

## 1. 功能

| 要求 | 实现 |
|---|---|
| 按模型独立记忆 | 存储键为 `provider::model`，显示名称不参与身份判断 |
| 切换模型自动恢复 | 拦截 Host 的 `sessionController.selectModel`，在一次调用内改写目标档位 |
| 自动保存手动修改 | 同一模型下的档位变化在原生调用成功后写入 |
| 持久化 | 使用 DSH 官方 `ctx.storageDomain`，文件位于 `$DSH_HOME/storages/effort_keeper.json` |
| Default 语义 | 显式 Default 存为 `null`，恢复时删除 `reasoningEffort`，不会错误套用旧档位 |
| 模型能力变化 | 恢复前通过 `ctx.llm.resolveModelInfo` 检查 `reasoning.efforts`；不支持则不传该档位 |
| 新会话 | 新建的空白会话按当前模型恢复偏好；已有对话不会在插件加载时被追溯修改 |
| 禁用/卸载 | 恢复被装饰的原方法；不修改 DSH 核心文件 |

不保存 API Key、聊天内容、工具参数或任何会话正文。

---

## 2. 为什么是 Host-only 插件

当前 DSH 的模型目录在 Client 侧（`@deepseek-ai/dsh-client-ui-model-selection`），但最终选择通过 Host 的公共方法提交：

```text
Client 模型菜单 → session.selectModel (Remote)
                 → ctx.sessionController.selectModel(request)
                 → resolveCallConfig + session.append('model/selection')
```

因此 EffortKeeper 不另做一套选择器，也不操作 DOM，而是在 Host 侧装饰**唯一入口** `ctx.sessionController.selectModel`：

1. 用户点击模型或档位时，原生调用照常发出；
2. 装饰器读取当前会话投影 `modelSelection`；
3. 如果是模型切换，且目标模型有已保存档位，则在同一请求对象中替换 `reasoningEffort` 后再执行原生实现；
4. 原生实现只执行一次，界面不会先显示错误档位再被第二次调用纠正；
5. 如果是同一模型下的档位变化，先让原生实现成功，再持久化用户选择。

插件卸载时会把原方法原样恢复。没有改 DSH 源码、`node_modules` 里的核心包或原生选择器。

### 关于全局默认模型

DSH 原生的 `selectModel` 本身会把当前选择写入 `agent-default-model` 的 profile 配置，这是 DSH 的既有行为，不是 EffortKeeper 的记忆机制。EffortKeeper 的记忆始终在独立的按模型存储中：

- 不会把某个档位批量套给所有模型；
- 不会通过反复改写全局默认来模拟“记忆”；
- 恢复一次档位与用户手动选择一次档位，都会触发 DSH 原生的 last-used 默认更新。

这一点是本插件与 DSH 当前 API 的边界，已在“已知限制”中说明。

---

## 3. 存储结构

DSH 的 storage domain 会在 `$DSH_HOME/storages/effort_keeper.json` 生成如下文件：

```json
{
  "unit": {
    "name": "effort_keeper",
    "version": 1
  },
  "global": {
    "version": 1,
    "preferences": {
      "openrouter-custom::anthropic/claude-sonnet-5.5": "high",
      "openrouter-custom::anthropic/claude-opus-5.5": "max",
      "openrouter-custom::google/gemini-4-argon": "medium",
      "openrouter-custom::anthropic/claude-sonnet-5.5-old": null
    }
  },
  "tables": {}
}
```

- 字符串：明确的档位 ID；
- `null`：用户明确选择了 Default；
- 键不存在：从未为该模型保存过偏好，恢复时保持 DSH 原生行为。

文件是独立 domain 文件，不覆盖 Provider、模型定义、`package.json` 或其他插件的配置。存储写入由 DSH storage domain 串行化并原子落盘。

---

## 4. 安装

### 4.1 准备

1. 完整退出 DSH Desktop（托盘也退出）。
2. 确认 DSH 版本在 `>=0.2.1-rc.3 <0.3.0-0`。
3. 使用本仓库的 `vendor/dsh-effort-keeper-1.0.5.tgz`，或先重新打包：

```powershell
pnpm pack --pack-destination vendor
```

### 4.2 用 DSH CLI 安装

```powershell
# 把 <DSH 安装目录> 换成本机的 DSH 安装路径，把 <repo> 换成插件仓库路径
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add `
  '<repo>\vendor\dsh-effort-keeper-1.0.5.tgz'
```

也可以直接从 GitHub 安装（会拉取源码，需要有可用的 pnpm 构建授权）：

```powershell
& $dsh plugin --profile desktop add `
  'github:ChimeSky/dsh-effort-keeper#v1.0.5'
```

CLI 会把包加入 profile 依赖和 `dsh.profile.bundles`，并由 DSH 自己的 pnpm 安装。也可以用 `tools/install.ps1`：

```powershell
pwsh -File .\tools\install.ps1
```

### 4.3 也可以在插件管理器里安装

在 DSH 的“插件”页面选择“安装本地插件 / bundle”，指向本目录或 tarball。安装后确认 `dsh-effort-keeper` 出现在插件列表中。

### 4.4 启动与验证

重新打开 DSH。验证接口：

```powershell
# 需要 DSH 页面同源 Cookie；在页面 DevTools Console 中执行：
fetch('/effort-keeper/status').then(r => r.json()).then(console.log)
```

预期：

```json
{
  "ok": true,
  "version": 1,
  "persistence": "storage-domain",
  "preferences": { "version": 1, "preferences": {} },
  "stats": { "restores": 0, "saves": 0, "unsupported": 0, "failures": 0 },
  "restoredSessions": 1
}
```

这个接口只返回模型路由键和档位 ID，不返回凭据、提示或聊天内容。

### 4.5 手工检查安装副本

```powershell
pwsh -File .\tools\verify-install.ps1
# 或
node .\tools\verify-install.mjs --profile desktop
```

会检查：

- profile 依赖与 bundle 列表；
- 已安装 `package.json` 名称/版本；
- 已安装 `index.js`、`lib/*.js` 与工作区源码逐字节一致；
- bundle patch 中的 `effort-keeper` 行。

---

## 5. 使用

不需要任何新操作：

1. 选择 Sonnet 5.5，把推理档位改为 High；
2. 切到 Gemini 4 Argon，把档位改为 Medium；
3. 切回 Sonnet 5.5；
4. 原生选择器应显示 High，接下来的请求头也使用 `reasoningEffort: "high"`。

切到从未设置过档位的模型时，保持 DSH 原生默认，不会错误恢复。

新建会话时，当前模型已有的偏好会被应用到新会话；已经开始的旧会话不会被追溯修改。

---

## 6. 禁用与卸载

### 禁用

- 在 DSH“插件”页面关闭 `EffortKeeper`；或
- 在 profile 的 `cordis.patch.yml` 中加：

```yaml
- id: effort-keeper
  disabled: true
```

禁用后装饰器会随 Cordis fiber 卸载而恢复，DSH 回到原生选择行为。

### 卸载

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop remove dsh-effort-keeper
```

然后确认 profile 的 `dsh.profile.bundles` 中不再有 `dsh-effort-keeper`（新版 CLI 会自动清理；没有则手工删除）。重启 DSH。

偏好文件 `$DSH_HOME/storages/effort_keeper.json` 可以保留。重新安装后会继续使用；如果不希望保留，确认没有其他插件使用该 domain 后删除该文件。

也可以用：

```powershell
pwsh -File .\tools\install.ps1 -Uninstall
```

---

## 7. 项目结构

```text
EffortKeeper/
├── index.js                 Host 入口、可选状态路由
├── lib/
│   ├── core.js              纯状态/选择规则（单元测试覆盖）
│   └── bridge.js            存储 domain、selectModel 装饰器、新会话恢复
├── cordis.patch.yml         bundle 插入行
├── locale/{zh,en}.json      插件显示元数据
├── icon.svg                 原创新图标
├── tests/
│   ├── core.test.mjs        13 个纯逻辑测试
│   └── bridge.test.mjs      8 个桥接/生命周期测试
├── tools/
│   ├── build-vendor.mjs     打包
│   ├── install.ps1          安装/卸载/校验
│   └── verify-install.mjs   安装副本校验
├── vendor/                  冻结 tarball
├── LICENSE                  MIT
├── README.md
└── TEST_REPORT.md           真实测试记录与已知限制
```

---

## 8. 配置

MVP 没有独立设置页，优先把行为合并进原生选择器。启用/禁用使用 DSH 插件管理器或 profile patch。

如需关闭自动记忆，直接禁用插件即可；不会影响其他配置。

---

## 9. 已知限制

1. **DSH 原生会更新全局默认**：`sessionController.selectModel` 的设计就是“保存 Session 选择 + 后台保存默认”。EffortKeeper 不把全局默认当作存储，但恢复动作仍会像手动选择一样更新它。这是 DSH `0.2.1-rc.3` 的公共 API 语义。
2. **Host 方法装饰**：插件包装的是公开服务方法，而不是修改源码。DSH 若在未来版本改变 `sessionController.selectModel` 的签名/存在性，插件会明确失败，不会静默写坏会话。升级大版本前请重新跑测试。
3. **已有会话不追溯**：插件安装或重启时只对“没有已提交 turn”的空白会话应用偏好；已经有对话的会话保持其历史选择。
4. **不发送未声明档位**：模型当前未声明的已保存档位会被忽略并记录非侵入式 debug 日志；原偏好保留，等模型能力恢复后仍可使用。
5. **不支持按模型自定义任意档位名**：只使用 adapter 公告的 `reasoning.efforts`。
6. **状态路由**：`/effort-keeper/status` 是只读诊断接口，只暴露模型路由键和档位 ID。它和其他本地 DSH 页面路由一样，只在 Web 宿主存在时注册。

---

## 10. 开发

```powershell
node --test tests/*.test.mjs
node --check index.js
node --check lib/core.js
node --check lib/bridge.js
```

改完源码后按“版本纪律”升 `package.json` 的 `version`，再重新打包：

```powershell
pnpm pack --pack-destination vendor
```

因为 DSH profile 使用 pnpm lockfile 的 `file:` tarball integrity，同名同版本但内容不同不会被重新读取。

---

## 11. License

MIT。`icon.svg` 为本项目原创绘制。
