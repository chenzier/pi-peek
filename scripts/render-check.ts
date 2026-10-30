/**
 * Render check for the /peek overlay: no TUI required.
 *
 * Prints the panel at a fixed width with synthetic state, so layout changes are
 * reviewable in a diff instead of by squinting at a terminal.
 *
 *   pnpm render-check
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { internals } from "../extensions/peek.ts";

// The real TUI initializes the theme at startup; the offline check must do it too.
initTheme("dark", false);

const theme = { fg: (_color: string, text: string) => text };
const stubTui = { requestRender() {} };

internals.state.running = true;
internals.state.runStartedAt = Date.now() - 843_000;
internals.state.turnIndex = 11;
internals.state.turnsCompleted = 11;
internals.state.tools.set("t1", {
	toolCallId: "t1",
	name: "bash",
	brief: "cd /repo && docker buildx build --push -t registry.example/sandbox:latest .",
	argsText: '{"command":"cd /repo && docker buildx build --push -t registry.example/sandbox:latest ."}',
	lastOutput: "#21 [linux/arm64 4/5] RUN pnpm build  (1m22s)",
	startedAt: Date.now() - 577_000,
});
internals.state.recent = [
	{ name: "bash", ms: 220, isError: false, brief: "tail /tmp/sandbox_build.log" },
	{ name: "grep", ms: 340, isError: false, brief: "SECRET_DIR" },
	{ name: "read", ms: 120, isError: false, brief: "cron_auth.py" },
	{ name: "bash", ms: 1500, isError: true, brief: "curl -X POST .../cloud-runs" },
];

const facts = () => ({
	phase: "running" as const,
	running: internals.state.running,
	elapsedMs: Date.now() - internals.state.runStartedAt,
	turns: internals.state.turnIndex,
	pending: true,
	contextText: "68%/200k",
	runningTools: [...internals.state.tools.values()],
	recentTools: internals.state.recent.slice(-4).reverse(),
});

const panel = new internals.ProgressPanel(
	stubTui as never,
	theme as never,
	{
		question: "现在在做什么？为什么要执行正在跑的那条命令？卡在哪里？离完成还差什么？",
		status: "done",
		answer: [
			"正在构建并推送沙箱镜像，`docker buildx` 已经跑了 **9 分 37 秒**，没有新的输出。",
			"",
			"- 停在 `linux/arm64` 的 `RUN pnpm build`",
			"- 之后是更新 E2B 模板指针",
			"",
			"## 建议",
			"再等 3 分钟；如果还没动静，`Esc` 中止后重跑。",
		].join("\n"),
		error: "",
		startedAt: Date.now(),
		abort: null,
		contextNote: "全量 128 条",
		seq: 0,
	},
	facts,
	{ onAbort() {}, onAsk() {}, onClose() {} },
);

for (const line of panel.render(78)) console.log(line);
panel.dispose();