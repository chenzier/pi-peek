/**
 * /peek — 旁路进度面板。
 *
 * 主 agent 跑长任务时，用户看不到进度，也能感知不到自己的提问在排队。
 * 这个命令在运行中立刻执行（扩展命令不排队），弹一个只读面板：
 *
 *   1. 确定性事实：轮次、运行时长、在跑的工具及其已耗时、排队消息、上下文占用
 *   2. 一次独立的小请求：拿到本会话的完整分支上下文，回答这些动作合起来在干什么、卡在哪
 *
 * 面板内容不写入主会话，不进入模型上下文。摘要请求是独立请求，不碰主 transcript。
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SYSTEM_PROMPT = [
	"你是主 agent 的旁路观察者。用户正在等待一个长任务，想知道真实的进度。",
	"输入的第一段是这个会话的完整上下文（可能很长），最后一段是当前的运行事实，以运行事实为准。",
	"只使用给定的内容。不要猜测，不要编造数字、文件名或结论。",
	"如果事实显示某个工具已经运行很久，就直接说这一点，不要粉饰成“正在推进”。",
	"不要承诺任何操作，不要道歉，不要输出标题或列表。",
	"用 2 到 4 句简体中文直接回答。",
].join(" ");

const DEFAULT_QUESTION = "现在进行到哪一步？卡在哪里？离完成还差什么？";
const IDLE_QUESTION = "上一次运行停在哪一步？还有什么没有做完？";
const RECENT_TOOLS_KEPT = 6;
/** Tool-call arguments are part of "what is this tool for", so full mode keeps them. */
const TOOL_CALL_ARG_CHARS = 240;
/**
 * Measured on a code-heavy Chinese transcript: 709 messages, 354k chars -> 320k tokens,
 * i.e. about 1.1 chars per token. Used only to size the budget.
 */
const CHARS_PER_TOKEN = 1.1;
/** Share of the model window the conversation may take; the rest is facts, question and answer. */
const CONTEXT_WINDOW_SHARE = 0.55;
/** This tail is never truncated, whatever the budget says. */
const PROTECTED_RECENT_MESSAGES = 40;
/**
 * Timestamp stamped on the appended question. A stable value keeps the request bytes steady so
 * the provider's prefix cache stays usable; pi never uses the value semantically.
 */
const APPENDED_MESSAGE_TIMESTAMP = 1_700_000_000_000;
/** Per-message caps tried in order when the transcript exceeds the budget (old messages only). */
const OLD_MESSAGE_CAPS = [8000, 4000, 2000, 900, 400, 200] as const;

interface ToolRun {
	toolCallId: string;
	name: string;
	brief: string;
	startedAt: number;
}

interface ToolDone {
	name: string;
	ms: number;
	isError: boolean;
	brief: string;
}

const state = {
	running: false,
	runStartedAt: 0,
	lastActivityAt: 0,
	turnIndex: 0,
	turnsCompleted: 0,
	tools: new Map<string, ToolRun>(),
	recent: [] as ToolDone[],
};

interface PanelState {
	question: string;
	status: "asking" | "done" | "error" | "aborted";
	answer: string;
	error: string;
	startedAt: number;
	abort: AbortController | null;
	/** How much conversation went into the summary request, e.g. "全量 128 条 / 41k 字符". */
	contextNote: string;
}

// ------------------------------------------------------------------ helpers

function formatMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function squash(text: string, max = 300): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const head = Math.floor(max * 0.6);
	const tail = max - head - 1;
	return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`;
}

function briefArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return squash(value, 90);
	}
	return squash(JSON.stringify(record), 90);
}

function messageText(message: unknown, toolCallArgChars = 0): string {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "toolCall" && typeof typed.name === "string") {
			// Arguments are what tell the model *what* the tool is doing, so full-context mode keeps them.
			const args = toolCallArgChars > 0 ? briefArgs(typed.arguments) : "";
			parts.push(args ? `[调用 ${typed.name} ${squash(args, toolCallArgChars)}]` : `[调用 ${typed.name}]`);
		}
	}
	return parts.join(" ");
}

function hasToolCall(message: unknown): boolean {
	const content = (message as { content?: unknown } | null)?.content;
	return Array.isArray(content) && content.some((block) => (block as { type?: string } | null)?.type === "toolCall");
}

function wrapText(text: string, width: number, maxLines: number): string[] {
	const limit = Math.max(1, width);
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const flat = paragraph.trim();
		if (flat.length === 0) {
			lines.push("");
			continue;
		}
		let line = "";
		for (const char of flat) {
			if (visibleWidth(line + char) > limit) {
				lines.push(line);
				line = char;
			} else {
				line += char;
			}
		}
		if (line.length > 0) lines.push(line);
	}
	if (lines.length <= maxLines) return lines;
	const clipped = lines.slice(0, maxLines);
	clipped[maxLines - 1] = `${truncateToWidth(clipped[maxLines - 1] ?? "", Math.max(1, limit - 1))}…`;
	return clipped;
}

// ------------------------------------------------------------- facts + digest

interface Facts {
	running: boolean;
	elapsedMs: number;
	turns: number;
	pending: boolean;
	contextText: string;
	runningTools: ToolRun[];
	recentTools: ToolDone[];
}

function buildFacts(ctx: ExtensionCommandContext): Facts {
	const usage = ctx.getContextUsage();
	const contextText = usage
		? usage.percent === null
			? `?/${formatTokens(usage.contextWindow)}`
			: `${Math.round(usage.percent)}%/${formatTokens(usage.contextWindow)}`
		: "?";
	const now = Date.now();
	return {
		running: state.running,
		elapsedMs: state.running ? now - state.runStartedAt : state.lastActivityAt ? now - state.lastActivityAt : 0,
		turns: state.running ? state.turnIndex : state.turnsCompleted,
		pending: ctx.hasPendingMessages(),
		contextText,
		runningTools: [...state.tools.values()],
		recentTools: state.recent.slice(-4).reverse(),
	};
}

function factsForModel(facts: Facts): string {
	const lines = [
		`状态: ${facts.running ? "运行中" : "空闲"}`,
		facts.running
			? `本次运行已持续: ${formatMs(facts.elapsedMs)}`
			: `距上次运行结束: ${formatMs(facts.elapsedMs)}`,
		`已完成轮次: ${facts.turns}`,
		`上下文占用: ${facts.contextText}`,
		`用户新消息在队列等待: ${facts.pending ? "是" : "否"}`,
	];
	if (facts.runningTools.length > 0) {
		const now = Date.now();
		lines.push(
			`正在执行的工具: ${facts.runningTools
				.map((tool) => `${tool.name}（已运行 ${formatMs(now - tool.startedAt)}）参数 ${tool.brief}`)
				.join(" ; ")}`,
		);
	}
	if (facts.recentTools.length > 0) {
		lines.push(
			`最近完成的工具: ${facts.recentTools
				.map((tool) => `${tool.name} ${formatMs(tool.ms)}${tool.isError ? "(失败)" : ""} ${tool.brief}`)
				.join(" ; ")}`,
		);
	}
	return lines.join("\n");
}

interface Payload {
	/** Real transcript messages, exactly as the agent would send them. */
	messages: unknown[];
	/** Short human label for the panel. */
	note: string;
}

/**
 * Rough text size of a message list. JSON.stringify would overstate it several times over
 * (ids, metadata, block wrappers), which made a 1M-window session look like it did not fit.
 */
function estimateChars(messages: unknown[]): number {
	let total = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown } | null)?.content;
		if (typeof content === "string") {
			total += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const typed = block as { type?: string; text?: string; arguments?: unknown };
			if (typed.type === "text" && typeof typed.text === "string") total += typed.text.length;
			else if (typed.type === "toolCall") total += JSON.stringify(typed.arguments ?? {}).length;
		}
	}
	return total;
}

function contextBudgetChars(ctx: ExtensionCommandContext): number {
	const window = ctx.model?.contextWindow ?? 200_000;
	return Math.max(60_000, Math.floor(window * CONTEXT_WINDOW_SHARE * CHARS_PER_TOKEN));
}

/**
 * Replay the active branch as real messages instead of a flattened text digest.
 *
 * This is the whole point: the main agent already sent `tools + system + messages` to the
 * provider, so a request with the same bytes reuses its cached prefix. Flattening the
 * transcript into one user message destroys that prefix and pays full price every time.
 */
function buildPayload(ctx: ExtensionCommandContext): Payload {
	let messages: unknown[];
	try {
		const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		messages = convertToLlm(built.messages) as unknown[];
	} catch {
		return { messages: [], note: "会话读取失败" };
	}

	const budget = contextBudgetChars(ctx);
	const size = estimateChars(messages);
	if (size <= budget) {
		return { messages, note: `全量 ${messages.length} 条` };
	}

	// Over budget: keep the opening (original task or the compaction summary that replaced it)
	// plus the recent tail. This breaks the cache prefix, so the panel says so.
	const head = messages.slice(0, 2);
	const tail = messages.slice(-PROTECTED_RECENT_MESSAGES);
	const kept = head.concat(tail.filter((message) => !head.includes(message)));
	return { messages: kept, note: `节选 ${kept.length}/${messages.length} 条（超窗口 ${formatTokens(size)} 字符）` };
}

/** The tool definitions the main agent declares, so the cached prefix matches. */
function activeToolDefinitions(pi: ExtensionAPI): unknown[] {
	const active = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// ----------------------------------------------------------------- UI panel

class ProgressPanel implements Component {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getFacts: () => Facts;
	private readonly slice: PanelState;
	private readonly onAbort: () => void;
	private readonly onRefresh: () => void;
	private readonly onClose: () => void;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		tui: TUI,
		theme: Theme,
		slice: PanelState,
		getFacts: () => Facts,
		actions: { onAbort: () => void; onRefresh: () => void; onClose: () => void },
	) {
		this.tui = tui;
		this.theme = theme;
		this.slice = slice;
		this.getFacts = getFacts;
		this.onAbort = actions.onAbort;
		this.onRefresh = actions.onRefresh;
		this.onClose = actions.onClose;
		// 面板里的秒表需要持续重绘；这个定时器只存在于此组件实例，关闭即清。
		this.timer = setInterval(() => this.tui.requestRender(), 500);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.slice.abort) this.onAbort();
			else this.onClose();
			return;
		}
		if (matchesKey(data, "r")) this.onRefresh();
	}

	render(width: number): string[] {
		const th = this.theme;
		const facts = this.getFacts();
		const innerWidth = Math.max(20, width - 2);
		const contentWidth = Math.max(10, innerWidth - 2);
		const body: string[] = [];

		const headline = [
			`${facts.running ? "运行中" : "空闲"} ${formatMs(facts.elapsedMs)}`,
			`turn ${facts.turns}`,
			`ctx ${facts.contextText}`,
			facts.pending ? "队列 1+" : "队列空",
		];
		body.push(` ${th.fg("muted", headline.join(" · "))}`);
		body.push("");

		if (facts.runningTools.length > 0) {
			for (const tool of facts.runningTools) {
				const elapsed = formatMs(Date.now() - tool.startedAt);
				body.push(` ${th.fg("accent", "▶")} ${th.fg("text", tool.name)} ${th.fg("warning", elapsed)}`);
				if (tool.brief) body.push(`   ${th.fg("dim", truncateToWidth(tool.brief, contentWidth - 3, "…"))}`);
			}
		} else if (facts.running) {
			body.push(` ${th.fg("muted", "▶ 等待模型响应…")}`);
		}

		for (const tool of facts.recentTools) {
			const mark = tool.isError ? th.fg("error", "✗") : th.fg("success", "✓");
			const brief = tool.brief ? `  ${th.fg("dim", truncateToWidth(tool.brief, Math.max(8, contentWidth - 20), "…"))}` : "";
			body.push(` ${mark} ${th.fg("muted", tool.name)} ${th.fg("dim", formatMs(tool.ms))}${brief}`);
		}

		body.push("");
		const elapsed = this.slice.status === "asking" ? formatMs(Date.now() - this.slice.startedAt) : undefined;
		const scope = this.slice.contextNote ? ` · ${this.slice.contextNote}` : "";
		const label =
			this.slice.status === "asking"
				? `摘要${scope} · 生成中 ${elapsed ?? ""}`
				: this.slice.status === "done"
					? `摘要${scope}`
					: this.slice.status === "aborted"
						? `摘要 · 已中止`
						: `摘要 · 失败`;
		body.push(` ${th.fg("muted", truncateToWidth(label, contentWidth))}`);
		if (this.slice.answer) {
			for (const line of wrapText(this.slice.answer, contentWidth, 12)) {
				body.push(` ${th.fg("text", line)}`);
			}
		} else if (this.slice.status === "asking") {
			body.push(` ${th.fg("dim", "…")}`);
		} else if (this.slice.error) {
			for (const line of wrapText(this.slice.error, contentWidth, 4)) {
				body.push(` ${th.fg("error", line)}`);
			}
		}

		body.push("");
		body.push(` ${th.fg("dim", truncateToWidth("Esc 关闭 · r 重新总结", contentWidth))}`);

		return this.box(body, width, `/peek · ${truncateToWidth(this.slice.question, Math.max(8, innerWidth - 18))}`);
	}

	private box(lines: string[], width: number, title: string): string[] {
		const th = this.theme;
		const innerWidth = Math.max(1, width - 2);
		const titleText = truncateToWidth(` ${title} `, innerWidth);
		const titleWidth = visibleWidth(titleText);
		const left = "─".repeat(Math.max(0, Math.floor((innerWidth - titleWidth) / 2)));
		const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));
		const output = [th.fg("border", `╭${left}`) + th.fg("accent", titleText) + th.fg("border", `${right}╮`)];
		for (const line of lines) {
			output.push(th.fg("border", "│") + truncateToWidth(line, innerWidth, "…", true) + th.fg("border", "│"));
		}
		output.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return output;
	}
}

// --------------------------------------------------------------- extension

export default function progressExtension(pi: ExtensionAPI) {
	pi.on("agent_start", () => {
		state.running = true;
		state.runStartedAt = Date.now();
		state.turnIndex = 0;
		state.turnsCompleted = 0;
		state.tools.clear();
		state.recent = [];
	});

	pi.on("turn_start", (event) => {
		state.turnIndex = event.turnIndex;
	});

	pi.on("turn_end", (event) => {
		state.turnsCompleted = event.turnIndex + 1;
		const text = messageText(event.message);
		if (text) state.lastActivityAt = Date.now();
	});

	pi.on("tool_execution_start", (event) => {
		state.tools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			name: event.toolName,
			brief: briefArgs(event.args),
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		const running = state.tools.get(event.toolCallId);
		state.tools.delete(event.toolCallId);
		state.recent.push({
			name: event.toolName,
			ms: event.durationMs ?? (running ? Date.now() - running.startedAt : 0),
			isError: event.isError,
			brief: running?.brief ?? "",
		});
		while (state.recent.length > RECENT_TOOLS_KEPT) state.recent.shift();
	});

	pi.on("agent_end", () => {
		state.running = false;
		state.tools.clear();
		state.lastActivityAt = Date.now();
	});

	async function ask(ctx: ExtensionCommandContext, slice: PanelState, render: () => void): Promise<void> {
		const model = ctx.model;
		if (!model) {
			slice.status = "error";
			slice.error = "当前没有可用模型";
			render();
			return;
		}
		const abort = new AbortController();
		slice.abort = abort;
		slice.status = "asking";
		slice.startedAt = Date.now();
		slice.answer = "";
		slice.error = "";
		render();

		const payload = buildPayload(ctx);
		slice.contextNote = payload.note;

		// Same system prompt, same messages, same tools as the main agent: only the tail below is
		// new, so the provider can reuse the cached prefix instead of re-billing the whole branch.
		const appended = {
			role: "user" as const,
			content: [
				SYSTEM_PROMPT,
				"",
				"【当前运行事实】",
				factsForModel(buildFacts(ctx)),
				"",
				"【用户的问题】",
				slice.question,
			].join("\n"),
			timestamp: APPENDED_MESSAGE_TIMESTAMP,
		};
		const tools = activeToolDefinitions(pi);
		const request = (withTools: boolean) => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages: [...payload.messages, appended] as never,
			...(withTools && tools.length > 0 ? { tools: tools as never } : {}),
		});

		try {
			let answer = await ctx.modelRegistry.complete(model, request(true), {
				maxTokens: 600,
				cacheRetention: "short",
				// Keep the cached prefix but forbid the model from actually running anything.
				toolChoice: "none",
				signal: abort.signal,
			});
			if (!messageText(answer).trim() && hasToolCall(answer)) {
				// A provider ignored toolChoice: drop the tools so it answers instead of acting.
				answer = await ctx.modelRegistry.complete(model, request(false), {
					maxTokens: 600,
					cacheRetention: "short",
					signal: abort.signal,
				});
			}
			slice.answer = messageText(answer).trim() || "(模型没有返回内容)";
			slice.status = "done";
		} catch (error) {
			if (abort.signal.aborted) {
				slice.status = "aborted";
			} else {
				slice.status = "error";
				slice.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			slice.abort = null;
			render();
		}
	}

	pi.registerCommand("peek", {
		description: "看一眼主 agent 现在在做什么（只读面板，不写入会话上下文）",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				const facts = buildFacts(ctx);
				ctx.ui.notify(
					`${facts.running ? "运行中" : "空闲"} ${formatMs(facts.elapsedMs)} · turn ${facts.turns} · ctx ${facts.contextText} · ${facts.pending ? "队列有消息" : "队列空"}`,
					"info",
				);
				return;
			}

			const question = args.trim() || (state.running ? DEFAULT_QUESTION : IDLE_QUESTION);
			let render = () => {};
			let closed = false;
			const slice: PanelState = {
				question,
				status: "asking",
				answer: "",
				error: "",
				startedAt: Date.now(),
				abort: null,
				contextNote: "",
			};

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					closed = false;
					render = () => {
						if (!closed) tui.requestRender();
					};
					const panel = new ProgressPanel(tui, theme, slice, () => buildFacts(ctx), {
						onAbort: () => {
							slice.abort?.abort();
							render();
						},
						onRefresh: () => {
							slice.abort?.abort();
							void ask(ctx, slice, render);
						},
						onClose: () => {
							closed = true;
							done();
						},
					});
					void ask(ctx, slice, render);
					return panel;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", width: "80%", maxHeight: "80%", margin: { top: 1 } },
				},
			);
			closed = true;
			slice.abort?.abort();
		},
	});
}

export const internals = {
	ProgressPanel,
	wrapText,
	formatMs,
	formatTokens,
	squash,
	buildPayload,
	activeToolDefinitions,
	contextBudgetChars,
	state,
};
