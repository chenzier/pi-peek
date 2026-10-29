/**
 * Render check for the /peek overlay: no TUI required.
 *
 * Prints the panel at a fixed width with synthetic state, so layout changes are
 * reviewable in a diff instead of by squinting at a terminal.
 *
 *   pnpm render-check
 */

import { internals } from "../extensions/peek.ts";

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
	startedAt: Date.now() - 577_000,
});
internals.state.recent = [
	{ name: "bash", ms: 220, isError: false, brief: "tail /tmp/sandbox_build.log" },
	{ name: "grep", ms: 340, isError: false, brief: "SECRET_DIR" },
	{ name: "read", ms: 120, isError: false, brief: "cron_auth.py" },
	{ name: "bash", ms: 1500, isError: true, brief: "curl -X POST .../cloud-runs" },
];

const facts = () => ({
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
		question: "现在进行到哪一步？卡在哪里？离完成还差什么？",
		status: "done",
		answer:
			"正在构建并推送沙箱镜像，docker buildx 已经跑了 9 分 37 秒，没有新的输出。这一步通常需要 10 分钟以上，目前不能中断。之后是更新模板指针。",
		error: "",
		startedAt: Date.now(),
		abort: null,
		contextNote: "全量 128 条 / 41k 字符",
	},
	facts,
	{ onAbort() {}, onRefresh() {}, onClose() {} },
);

for (const line of panel.render(78)) console.log(line);
panel.dispose();