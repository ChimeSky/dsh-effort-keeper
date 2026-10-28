# EffortKeeper 测试报告

测试日期：2026-10-28  
测试机型：Windows 11 / DSH Desktop `0.2.1-rc.3` / Node 24  
测试配置：独立临时 `DSH_HOME` + 独立 `web` profile；使用真实 OpenRouter 路由：

- `openrouter-custom` / `anthropic/claude-sonnet-5.5`
- `openrouter-custom` / `anthropic/claude-opus-5.5`
- `openrouter-custom` / `google/gemini-4-argon`

没有修改用户正在使用的 `desktop` profile 来跑测试。

---

## 1. 自动化测试

命令：

```powershell
node --test tests/*.test.mjs
```

结果：

```text
tests 21
pass 21
fail 0
```

覆盖内容：

| 文件 | 覆盖点 |
|---|---|
| `tests/core.test.mjs` | Provider+Model 身份、状态 schema、Default=null、首访不恢复、Sonnet/Gemini/Opus 恢复、不支持档位、未知能力、显式档位优先、保存更新 |
| `tests/bridge.test.mjs` | `selectModel` 装饰/原样恢复、一次调用完成恢复、手动修改落盘、Default 落盘、新会话恢复、已有会话不追溯、卸载关闭 domain、热重载不叠加装饰器 |

其中重点断言：

- 模型切换时，原生 `selectModel` 只被调用 **1 次**，请求中的 `reasoningEffort` 已在调用前替换；
- 从未保存过的模型不产生任何恢复调用；
- 已保存但当前模型不再 advertise 的档位不会进入请求；
- 默认值保存为 `null`，不是空字符串、`"default"` 或 `"medium"`。

---

## 2. 真实 UI / 交互测试

通过 Playwright 驱动真实 DSH Web UI，操作原生模型选择器和推理等级菜单。

### 2.1 三种模型互相切换

| 操作 | 界面结果 |
|---|---|
| Sonnet → High | `Claude Sonnet 5.5 High` |
| 切到 Gemini（首次） | `Gemini 4 Argon Default` |
| Gemini → Medium | `Gemini 4 Argon Medium` |
| 切回 Sonnet | `Claude Sonnet 5.5 High` ✅ |
| 切到 Opus（首次） | `Claude Opus 5.5 Default` |
| Opus → Max | `Claude Opus 5.5 Max` |
| 切到 Gemini | `Gemini 4 Argon Medium` ✅ |
| 切回 Opus | `Claude Opus 5.5 Max` ✅ |
| 切回 Sonnet | `Claude Sonnet 5.5 High` ✅ |

状态接口在测试结束时的记录：

```json
{
  "version": 1,
  "preferences": {
    "openrouter-custom::anthropic/claude-opus-5.5": "max",
    "openrouter-custom::anthropic/claude-sonnet-5.5": "high",
    "openrouter-custom::google/gemini-4-argon": "medium"
  },
  "stats": {
    "restores": 5,
    "saves": 5,
    "unsupported": 0,
    "failures": 0
  }
}
```

### 2.2 显式 Default

在 Sonnet 选择 Default 后：

```json
"openrouter-custom::anthropic/claude-sonnet-5.5": null
```

切到 Opus 再切回 Sonnet，界面仍为 `Default`，没有被旧的 `High` 覆盖。✅

### 2.3 界面与实际 API 请求一致

发送真实请求后，从会话日志的 `request/header` 读取实际配置：

**Sonnet 5.5，界面 High：**

```json
{
  "provider": "openrouter-custom",
  "model": "anthropic/claude-sonnet-5.5",
  "reasoningEffort": "high",
  "maxTokens": 128000
}
```

**Gemini 4 Argon，界面 Medium：**

```json
{
  "provider": "openrouter-custom",
  "model": "google/gemini-4-argon",
  "reasoningEffort": "medium",
  "maxTokens": 65536
}
```

**Sonnet 5.5，界面 Default：**

```json
{
  "provider": "openrouter-custom",
  "model": "anthropic/claude-sonnet-5.5",
  "maxTokens": 128000
}
```

注意第三段**没有** `reasoningEffort` 字段，证明 Default 没有被写成 Medium，也没有发送 `null` 或伪造档位。✅

---

## 3. 持久化与重启

关闭测试 Host，再以同一个临时 `DSH_HOME` 重启后：

- `/effort-keeper/status` 仍返回三个模型的偏好；
- 当前会话仍显示 `Claude Sonnet 5.5 High`；
- 新建会话仍显示 `High`。

状态文件实际写入：

```json
{
  "unit": { "name": "effort_keeper", "version": 1 },
  "global": {
    "version": 1,
    "preferences": {
      "openrouter-custom::anthropic/claude-opus-5.5": "max",
      "openrouter-custom::anthropic/claude-sonnet-5.5": "high",
      "openrouter-custom::google/gemini-4-argon": "medium"
    }
  },
  "tables": {}
}
```

---

## 4. 新会话恢复（不依赖全局默认）

为了区分“读到了全局默认”与“插件恢复”，临时把 profile 的 `agent-default-model` 改成：

```yaml
provider: openrouter-custom
model: anthropic/claude-sonnet-5.5
# 没有 reasoningEffort
```

重启并打开新会话：

```text
新会话界面: Claude Sonnet 5.5 High
status.stats.restores: 1
```

说明新会话的 High 来自 EffortKeeper 的模型偏好，而不是原生默认。✅

---

## 5. 模型能力变化

把 Gemini 的配置临时改成只声明：

```yaml
reasoningEfforts:
  low: low
```

但存储里仍然是：

```json
"openrouter-custom::google/gemini-4-argon": "medium"
```

重启后切到 Gemini：

```text
界面: Gemini 4 Argon Default
status.stats.unsupported: 1
存储: 仍保留 "medium"
```

没有向模型发送 `medium`，也没有删除用户的旧偏好；能力恢复后仍可再次恢复。✅

---

## 6. 禁用插件

在测试 profile 的 patch 中：

```yaml
- id: effort-keeper
  disabled: true
```

重启后：

```text
Sonnet（存储中为 High）→ 界面 Default
/effort-keeper/status → HTTP 404
```

说明卸载/禁用后 DSH 回到原生行为，装饰器没有残留。✅

---

## 7. 实际 Desktop profile 安装

最终安装目标：`$DSH_HOME/profiles/desktop`。

安装结果：

```text
dsh-effort-keeper@1.0.5
dependencies +1
bundle list contains dsh-effort-keeper
All 15 install checks passed.
```

安装后不重启 DSH，直接探测实际运行中的 Desktop Host：

```text
GET http://127.0.0.1:56470/effort-keeper/status
200 {"ok":true,"version":1,"persistence":"storage-domain",
     "preferences":{"version":1,"preferences":{}},
     "stats":{"restores":0,"saves":0,"unsupported":0,"failures":0},
     "restoredSessions":4}
```

说明 Host 插件已经激活并注册了只读诊断路由；4 个空白会话被识别，但没有可恢复的偏好（用户尚未在 Desktop 里手动选择档位）。实际选择/恢复流程已在独立的等价 profile 中完成端到端验证。

---

## 8. 已知限制

1. **原生 last-used 默认仍会更新。** DSH 的 `sessionController.selectModel` 在实现中会异步调用 `agentDefaultModel.saveSelection(selected)`。EffortKeeper 不把全局默认当作存储，但它恢复一次档位仍会像用户手动选择一样更新这个原生默认。这是 DSH `0.2.1-rc.3` 的公共 API 行为，不是插件用全局默认模拟记忆。
2. **装饰的是 Host 服务方法。** 不是 DOM 轮询，也不是核心文件补丁；但它依赖 `sessionController.selectModel` 在未来的 DSH 版本中继续存在。不兼容时插件会报错，不会发出非法档位。
3. **已有会话不追溯。** 插件加载/重启时只对空白会话应用偏好；已有对话保持其选择。
4. **没有独立设置页。** MVP 的开关就是插件管理器的启用/禁用；这避免为了一个布尔值增加前端状态同步风险。
5. **状态路由只读。** `/effort-keeper/status` 不提供修改/删除接口，避免暴露写能力。

---

## 9. 测试结论

对照需求：

| # | 验收项 | 结果 |
|---|---|---|
| 1 | Sonnet High → Gemini → Sonnet 恢复 High | 通过 |
| 2 | Gemini Medium → Opus → Gemini 恢复 Medium | 通过 |
| 3 | Opus Max → 其他 → Opus 恢复 Max | 通过 |
| 4 | 修改已保存档位后旧记录更新 | 通过 |
| 5 | 重启后记录仍有效 | 通过 |
| 6 | 新会话恢复模型偏好 | 通过 |
| 7 | 首次使用新模型不发生错误恢复 | 通过 |
| 8 | 不支持档位不产生非法参数 | 通过 |
| 9 | 手动 Default 不被旧档位覆盖 | 通过 |
| 10 | 禁用插件恢复原生行为 | 通过 |
| — | 界面显示与实际请求头一致 | 通过（三种情况均核对） |
