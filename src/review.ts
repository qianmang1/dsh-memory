/**
 * The review tool — the queue's non-UI door.
 *
 * Deliberately thin: the decision flow (dedupe → supersede or faithful write →
 * record) lives in `decisions.ts`, because the sidebar route opens the same door
 * and a second copy of that order would drift.
 * @module dsh-memory/review
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { approveEntry, dismissEntry, pendingView, type DecisionDeps } from './decisions.ts'

/** The tool needs exactly what a decision needs. */
export type ReviewDeps = DecisionDeps

/**
 * Register `memory_review`.
 * @param ctx Host context.
 * @param deps Queue, client factory, and the dedupe threshold.
 */
export function registerReviewTool(ctx: Context, deps: ReviewDeps): void {
  ctx.tools.register(defineTool({
    name: 'memory_review',
    description: '长期记忆：查看候审队列并批准或驳回候选事实。批准时先判重——命中已有记忆则取代它，否则保真新增。侧边栏待审页不可用时的替代入口。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | approve | dismiss' },
      id: { type: 'string', description: 'approve / dismiss 的条目 id（memory_review list 返回的完整 id 或其前几位）。' },
      note: { type: 'string', description: '可选备注，作为 decided_by 记入条目。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'list') return { text: pendingView(await deps.queue.list()).text }

      // Validate the verb before the argument: reporting "needs an id" for an
      // action that does not exist sends the reader down the wrong path.
      if (args.action !== 'approve' && args.action !== 'dismiss') {
        return { text: `未知 action：${args.action}（支持 list | approve | dismiss）。` }
      }
      if (args.id === undefined) return { text: `${args.action} 需要 id；先用 memory_review list 查看。` }

      const result = args.action === 'approve'
        ? await approveEntry(deps, args.id, args.note)
        : await dismissEntry(deps.queue, args.id, args.note)
      return { text: result.text }
    },
  }))
}
