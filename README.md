# pi-peek

一眼看到主 agent 现在到底在做什么 —— 只读面板，不写入会话上下文，不打断正在跑的任务。

```
/peek
```

面板浮在正在运行的会话上方：下面那半屏是主 agent 的实时输出，主输入框和正在跑的任务都不受影响。

![真实终端里的 /peek 面板](docs/screenshot.png)

## 为什么需要它

pi 在跑长任务时，用户看不到进度。两个具体后果：

1. **黑屏**：状态行只有一个转圈和 `Working (esc to interrupt)`，没有耗时、没有轮次、没有当前工具。
2. **消息排队**：这时输入 `Enter` 发出一条消息，它进入 steering 队列，要等**当前这一轮的全部工具跑完**才交给模型。如果一个 bash 跑 10 分钟，你的问题就等 10 分钟。

`/peek` 解决第 1 条：扩展命令在流式过程中**立即执行**，不排队，打开面板就能看到真实进度。

## 安装

```bash
# 从 git
pi install git:https://github.com/chenzier/pi-peek

# 临时试用，不安装
pi --extension /path/to/pi-peek/extensions/peek.ts
```

或者把 `extensions/peek.ts` 复制到 `~/.pi/agent/extensions/`（单文件即可运行）。

## 用法

```
/peek                    # 默认问：在做什么、为什么跑那条命令、卡在哪
/peek 这条 buildx 会跑多久 # 自定义问题
```

面板底部有输入框，**可以连续追问**，不用关窗重开：

| 键 | 作用 |
| --- | --- |
| `Enter` | 提交追问（空着提交 = 用同一个问题重新问一次） |
| `Esc` | 生成中：中止这次请求；空闲：关闭面板 |
| `↑` / `↓` | 上下滚动长回答（一次显示 10 行） |

追问复用同一份上下文（同样的 tools / system prompt / 历史），所以第二次只付新问题的几十个 token——前缀缓存直接命中。

## 面板里有两种信息

**上半：确定性事实，不调用模型。** 每 0.5 秒刷新，秒表会走。

| 内容 | 来源 |
| --- | --- |
| 运行 / 空闲，已耗时 | `agent_start` / `agent_end` |
| 第几轮 | `turn_start.turnIndex` |
| 正在执行哪些工具、各自已耗时 | `tool_execution_start` |
| 最近完成的工具、耗时、是否失败 | `tool_execution_end.durationMs` |
| 新消息是否在队列里等待 | `ctx.hasPendingMessages()` |
| 上下文占用 | `ctx.getContextUsage()` |

**下半：一次独立的小请求。** 它发的不是压缩摘要，而是**和主 agent 一模一样的请求**：

```
tools（与主会话相同）→ system prompt（ctx.getSystemPrompt()）→ 真实消息 → 追加一句问题
```

为什么这么做：主 agent 刚刚用同样的字节发过请求，provider 的前缀缓存里有这一大段。我们只追加一个问题，尾部的几十个 token 是新的，前面全部命中。**实战测量**（`ep-copilot2/deepseek-v4.1-flash`，709 条消息）：

| 请求 | input | cacheRead |
| --- | --- | --- |
| 第一次 | 319,953 | 22,528 |
| 10 秒后 | 319,953 | 23,168 |
| 20 秒后 | 319,953 | **319,872（99.97%）** |

注意缓存**写入要几秒钟才可见**：连按两次 `r` 通常吃不到，隔十几秒再按就吃满。把它理解成"同一轮 run 里反复看会越来越便宜"比较准。

把 transcript 拍平成一段文本会让 token 序列完全变样，那就一次都命中不了——这是这版和早期版本最大的区别。

`toolChoice: "none"` 让前缀保持一致的同时禁止模型真的去调工具（否则它会接着干活而不是回答）。万一某个 provider 忽略它，面板会把工具摘掉重发一次。追加消息的 timestamp 固定，避免请求抖动。

超过模型窗口预算时才退化成「开头 2 条（原始任务或压缩摘要）+ 最近 40 条」，此时面板写 `节选 62/709 条（超窗口）`。

事实在上、摘要在下，是有意的：确定性数据压住模型的措辞。

## 「不进入上下文」是构造保证

- 面板文字只写入终端，不写回主 transcript。
- 摘要是一次独立的 `ctx.modelRegistry.complete()` 调用，不追加用户消息，不触发新一轮 agent loop。
- 事件处理器只读：任何 handler 都不修改消息、工具或会话条目。

## 成本与限制

- **成本**：709 条消息的会话实测 **319,953 输入 token**（889k 字符，约 2.8 字符/token）。第一次全价，缓存可见后只付新 token。短任务通常几千到几万 token。
- **窗口预算**：允许上下文占模型窗口的 55%（按 2.8 字符/token 实测值估算）。1M 窗口 → 1.54M 字符，200k 窗口 → 308k 字符。超预算才退化成节选模式。
- **缓存是概率的**：provider 侧的条目有写入延迟，也会被淘汰。命中不到时就是全价，功能本身不受影响。
- 面板打开时**抓焦点**，主输入框暂时收不到按键。这是有意的：`Esc` 永远关面板，不会误 abort 主 agent。想边看面板边继续对话，把 `peek.ts` 里的 `overlayOptions` 加上 `nonCapturing: true`，届时关闭要靠 `/peek` 重新触发。
- 队列只显示是否存在（`hasPendingMessages()` 不暴露条数），所以写作 `队列 1+`。
- 长工具在飞时不会有新事实 —— 这正是它的用途：面板会显示 `bash 9m37s` 和"没有新的输出"，而不是假装在推进。

## 开发

```bash
pnpm install
pnpm typecheck      # tsc --strict
pnpm render-check   # 用合成状态打印面板，不需要 TUI（输出见 docs/panel.txt）
```

在 pi 1.1.0 上开发与验证；类型检查同时对 `@earendil-works/pi-coding-agent@1.4.0` 通过。

## License

MIT