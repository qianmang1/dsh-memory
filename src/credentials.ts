/**
 * mem0 credential resolution.
 *
 * The API key never appears in plugin config: it is read per operation through
 * `ctx.credentials`, which layers the process environment, `.env` files, and
 * the provider-managed store. Resolution is per call by contract — caching a
 * key across operations would keep a rotated credential invisible until the
 * next restart.
 * @module dsh-memory/credentials
 */

import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** Credential refs; the same names the Python MCP bridge reads, so migration needs no environment change. */
export const MEM0_API_KEY_REF = 'MEM0_API_KEY'
export const MEM0_BASE_URL_REF = 'MEM0_BASE_URL'
export const MEM0_USER_ID_REF = 'MEM0_USER_ID'

/** The three deployment values one mem0 call needs. */
export interface Mem0Credentials {
  /** Service base URL, no trailing slash. */
  baseUrl: string
  /** Secret sent as `X-API-Key`. */
  apiKey: string
  /** Memory owner id. */
  userId: string
}

/** The `ctx.credentials` surface this module uses; a host without it fails closed with an actionable message. */
interface CredentialReader {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

/**
 * Resolve the endpoint, key, and owner for one operation.
 * @param ctx Host context; `ctx.get('credentials')` is read opportunistically so a host without the service degrades to a clear error rather than a load failure.
 * @param config Plugin config values that override the credential layer.
 * @returns The resolved triple.
 * @throws Error naming every missing value and where to configure it.
 */
export async function resolveMem0Credentials(
  ctx: Context,
  config: { baseUrl?: string; userId?: string },
): Promise<Mem0Credentials> {
  const reader = ctx.get('credentials') as CredentialReader | undefined
  const read = async (ref: string): Promise<string | undefined> => {
    if (reader === undefined || !isCredentialRefName(ref)) return undefined
    const resolved = await reader.resolve(credentialRef(ref))
    return resolved?.value
  }

  const baseUrl = config.baseUrl?.trim() || await read(MEM0_BASE_URL_REF)
  const apiKey = await read(MEM0_API_KEY_REF)
  const userId = config.userId?.trim() || await read(MEM0_USER_ID_REF)

  if (!baseUrl || !apiKey || !userId) {
    const missing: string[] = []
    if (!baseUrl) missing.push(`baseUrl（插件配置或 ${MEM0_BASE_URL_REF} 凭据）`)
    if (!apiKey) missing.push(`${MEM0_API_KEY_REF} 凭据`)
    if (!userId) missing.push(`userId（插件配置或 ${MEM0_USER_ID_REF} 凭据）`)
    const hint = reader === undefined
      ? '宿主未提供 credentials 服务，请改用插件配置或进程环境变量。'
      : '把值写入 ~/.dsh/.credentials.yaml 或进程环境变量后重试。'
    throw new Error(`dsh-memory: 缺少 ${missing.join('、')}。${hint}`)
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, userId }
}
