window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* The sidebar tab — the review queue's UI door.
		*
		* It talks to the host route (`/memory/pending`) rather than the queue files:
		* the browser side has no filesystem, and the route is where approve/dismiss
		* reuse the same decision flow as the tool.
		*
		* `ctx.betterSidebar` stays optional at runtime: it is reached with `ctx.get`,
		* never `inject`, so a host without the sidebar keeps the tools, hooks, and
		* queue (the reviewer then uses `memory_review`). That optionality lives in the
		* runtime lookup only — the descriptor and props types come from
		* `dsh-better-sidebar` itself (a devDependency, absent from the published
		* manifest), so a renamed field fails `npm run typecheck` instead of silently
		* rendering nothing.
		* @module dsh-memory/client
		*/
		/** The route this tab calls; same constant the host registers. */
		const PENDING_ENDPOINT = "/memory/pending";
		async function requestJson(url, init) {
			const response = await fetch(url, init);
			const payload = await response.json();
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
			return payload;
		}
		const shortId = (id) => id.slice(0, 6);
		/**
		* Fetch the pending view once and after every decision.
		* @returns State and actions for the tab body.
		*/
		function usePendingQueue() {
			const [entries, setEntries] = (0, react.useState)([]);
			const [message, setMessage] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const refresh = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					const payload = await requestJson(PENDING_ENDPOINT);
					setEntries(payload.entries ?? []);
					setMessage(payload.text);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, []);
			const decide = (0, react.useCallback)(async (id, action) => {
				setBusy(true);
				try {
					const payload = await requestJson(`${PENDING_ENDPOINT}/${action}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							id,
							note: "sidebar"
						})
					});
					setMessage(payload.text);
					await refresh();
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
					setBusy(false);
				}
			}, [refresh]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			return {
				entries,
				message,
				busy,
				refresh,
				decide
			};
		}
		/** The registered tab body. */
		function MemoryPendingTab({ scope }) {
			const { entries, message, busy, refresh, decide } = usePendingQueue();
			const session = scope?.sessionId;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "12px",
					fontSize: "13px",
					lineHeight: 1.6
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: "8px",
							marginBottom: "8px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "记忆待审" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								refresh();
							},
							disabled: busy,
							children: "刷新"
						})]
					}),
					session === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							opacity: .6,
							marginBottom: "8px"
						},
						children: ["会话 ", session.slice(0, 8)]
					}),
					message === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							opacity: .8,
							marginBottom: "8px"
						},
						children: message
					}),
					entries.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: {
							listStyle: "none",
							padding: 0,
							margin: 0
						},
						children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: {
								borderTop: "1px solid currentColor",
								padding: "8px 0"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: entry.text }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										opacity: .6,
										fontSize: "12px"
									},
									children: [
										"[",
										shortId(entry.id),
										"] ",
										String(entry.metadata?.["category"] ?? "未分类"),
										" · conf ",
										entry.confidence.toFixed(2)
									]
								}),
								entry.evidence === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										opacity: .6,
										fontSize: "12px"
									},
									children: ["证据：", entry.evidence]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: "8px",
										marginTop: "6px"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: busy,
										onClick: () => {
											decide(entry.id, "approve");
										},
										children: "批准"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: busy,
										onClick: () => {
											decide(entry.id, "dismiss");
										},
										children: "驳回"
									})]
								})
							]
						}, entry.id))
					})
				]
			});
		}
		const name = "memory-tab";
		/**
		* Register the tab when the sidebar plugin is present.
		* @param ctx Client context.
		*/
		function apply(ctx) {
			const sidebar = ctx.get?.("betterSidebar");
			if (typeof sidebar?.registerTab !== "function") return;
			try {
				const dispose = sidebar.registerTab({
					id: "dsh-memory:pending",
					title: "记忆待审",
					description: "候审的候选事实：批准后写入 mem0，驳回后不再询问。",
					order: 60,
					component: MemoryPendingTab
				});
				ctx.effect?.(() => dispose, "dsh-memory: pending tab");
			} catch (error) {
				ctx.logger?.warn?.(`dsh-memory: 待审 Tab 注册失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		//#endregion
		exports.MemoryPendingTab = MemoryPendingTab;
		exports.apply = apply;
		exports.name = name;
		exports.usePendingQueue = usePendingQueue;
		return module.exports;
	}
});
