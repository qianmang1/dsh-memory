window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* The sidebar tab — the review queue's UI door, on the native right sidebar.
		*
		* It talks to the host route (`/memory/pending`) rather than the queue files:
		* the browser side has no filesystem, and the route is where approve/dismiss
		* reuse the same decision flow as the tool.
		*
		* Registration follows the first-party right-sidebar contract (the same path
		* the bundled session inspector takes): `ctx.sidebarRightTabs.register`
		* declares the tab type, and a keyed slot under `sidebar.right.pane.tab`
		* supplies the body — the slot key must equal the definition's `id`. The
		* earlier dsh-better-sidebar route never rendered on the web host: the module
		* loaded and applied fine, but the third-party tab never surfaced in that
		* panel, so this module now rides the native slot system instead.
		*
		* Visuals come from `@deepseek-ai/dsh-client-ui-primitives` (host-supplied at
		* runtime — see vendor-types.d.ts and the client build's neverBundle) and
		* `--dsw-*` alias tokens, so the tab follows the active theme instead of
		* hard-coding colors.
		* @module dsh-memory/client
		*/
		/** The route this tab calls; same constant the host registers. */
		const PENDING_ENDPOINT = "/memory/pending";
		/** Poll cadence for the queue; the tab only refreshes while visible. */
		const POLL_MS = 15e3;
		/** Tab identity: the slot key under `sidebar.right.pane.tab` equals this id. */
		const TAB_ID = "dsh-memory";
		/** Type discriminator used by `openTab` and the guide page. */
		const TAB_KIND = "dsh-memory-pending";
		async function requestJson(url, init) {
			const response = await fetch(url, init);
			const payload = await response.json();
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
			return payload;
		}
		const shortId = (id) => id.slice(0, 6);
		/** Colors for the confidence bar, keyed off the --dsw state aliases. */
		function confidenceColor(confidence) {
			if (confidence >= .8) return "var(--dsw-alias-state-success-primary)";
			if (confidence >= .6) return "var(--dsw-alias-state-business-primary)";
			return "var(--dsw-alias-state-warn-primary)";
		}
		/** Alias tokens used by this tab; kept in one place for easy auditing. */
		const styles = {
			root: {
				padding: "12px",
				fontSize: "var(--dsw-font-xs-13)",
				lineHeight: 1.6,
				color: "var(--dsw-alias-label-primary)"
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				marginBottom: "10px"
			},
			title: { fontWeight: 600 },
			spacer: { flex: 1 },
			quiet: { color: "var(--dsw-alias-label-tertiary)" },
			secondary: { color: "var(--dsw-alias-label-secondary)" },
			notice: {
				color: "var(--dsw-alias-label-secondary)",
				marginBottom: "8px"
			},
			filterRow: { marginBottom: "10px" },
			list: {
				listStyle: "none",
				padding: 0,
				margin: 0
			},
			item: {
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				padding: "10px 0"
			},
			itemText: {
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				marginBottom: "4px"
			},
			metaRow: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				fontSize: "12px",
				marginBottom: "6px"
			},
			track: {
				width: "56px",
				height: "4px",
				borderRadius: "var(--dsw-radius-sm)",
				background: "var(--dsw-alias-border-l4)",
				overflow: "hidden",
				flexShrink: 0
			},
			actions: {
				display: "flex",
				gap: "8px"
			},
			empty: {
				padding: "24px 0",
				textAlign: "center"
			}
		};
		/**
		* Fetch the pending view once, after every decision, and on a visibility-gated
		* poll so the tab picks up captures made while the user was reading.
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
			(0, react.useEffect)(() => {
				const timer = setInterval(() => {
					if (document.visibilityState === "visible") refresh();
				}, POLL_MS);
				return () => {
					clearInterval(timer);
				};
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
		function MemoryPendingTab({ injected }) {
			const { entries, message, busy, refresh, decide } = usePendingQueue();
			const [filter, setFilter] = (0, react.useState)("all");
			const session = injected?.sessionId;
			const categories = (0, react.useMemo)(() => {
				const set = /* @__PURE__ */ new Set();
				for (const entry of entries) set.add(String(entry.metadata?.["category"] ?? "未分类"));
				return [...set].sort();
			}, [entries]);
			const visible = (0, react.useMemo)(() => filter === "all" ? entries : entries.filter((entry) => String(entry.metadata?.["category"] ?? "未分类") === filter), [entries, filter]);
			const filterTabs = (0, react.useMemo)(() => {
				return [{
					value: "all",
					label: `全部 ${entries.length}`,
					id: "dsh-memory-tab-all",
					panelId: "dsh-memory-panel-all"
				}, ...categories.map((category) => ({
					value: category,
					label: category,
					id: `dsh-memory-tab-${category}`,
					panelId: `dsh-memory-panel-${category}`
				}))];
			}, [categories, entries.length]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.header,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: styles.title,
								children: "记忆待审"
							}),
							entries.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
								tone: "solid",
								children: entries.length
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: styles.spacer }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								onClick: () => {
									refresh();
								},
								disabled: busy,
								children: "刷新"
							})
						]
					}),
					session === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...styles.quiet,
							marginBottom: "8px"
						},
						children: ["会话 ", session.slice(0, 8)]
					}),
					message === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.notice,
						children: message
					}),
					categories.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.filterRow,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
							items: filterTabs,
							value: filter,
							onChange: setFilter,
							label: "按分类筛选"
						})
					}) : null,
					busy && entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TextShimmer, {
						active: true,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.quiet,
							children: "读取待审队列…"
						})
					}) : entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...styles.empty,
							...styles.quiet
						},
						children: ["队列为空", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: "12px",
								marginTop: "4px"
							},
							children: "捕获组件产生候选记忆后会出现在这里"
						})]
					}) : visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...styles.empty,
							...styles.quiet
						},
						children: "该分类下没有待审条目"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: styles.list,
						children: visible.map((entry) => {
							const category = String(entry.metadata?.["category"] ?? "未分类");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								style: styles.item,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: styles.itemText,
										children: entry.text
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: styles.metaRow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
												tone: "neutral",
												children: category
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: styles.quiet,
												title: `置信度 ${entry.confidence.toFixed(2)}`,
												children: shortId(entry.id)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: styles.track,
												title: `置信度 ${entry.confidence.toFixed(2)}`,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
													width: `${Math.round(Math.min(Math.max(entry.confidence, 0), 1) * 100)}%`,
													height: "100%",
													background: confidenceColor(entry.confidence)
												} })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: styles.quiet,
												children: ["conf ", entry.confidence.toFixed(2)]
											})
										]
									}),
									entry.evidence === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											...styles.quiet,
											fontSize: "12px",
											marginBottom: "6px"
										},
										children: ["证据：", entry.evidence]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: styles.actions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "primary",
											size: "sm",
											disabled: busy,
											onClick: () => {
												decide(entry.id, "approve");
											},
											children: "批准"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: busy,
											onClick: () => {
												decide(entry.id, "dismiss");
											},
											children: "驳回"
										})]
									})
								]
							}, entry.id);
						})
					})
				]
			});
		}
		/** cordis services required to register the sidebar tab. */
		const inject = ["slots", "sidebarRightTabs"];
		const name = "memory-tab";
		/**
		* Register the tab on the native right sidebar for this plugin's lifetime.
		* @param ctx Client plugin context.
		*/
		function apply(ctx) {
			const faces = ctx;
			const { slots, sidebarRightTabs } = faces;
			if (slots === void 0 || sidebarRightTabs === void 0) {
				faces.logger?.warn?.("dsh-memory: slots/sidebarRightTabs 服务缺失，待审 Tab 未注册");
				return;
			}
			ctx.effect(() => sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => "记忆待审",
				guide: [{
					id: "open",
					order: 60,
					title: () => "记忆待审",
					description: () => "候审的候选事实：批准后写入 mem0，驳回后不再询问。"
				}]
			}), "dsh-memory: sidebar tab");
			slots.inject("sidebar.right.pane.tab", () => slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				inject: (sessionId) => ({ sessionId })
			}, MemoryPendingTab));
		}
		//#endregion
		exports.MemoryPendingTab = MemoryPendingTab;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.usePendingQueue = usePendingQueue;
		return module.exports;
	}
});
