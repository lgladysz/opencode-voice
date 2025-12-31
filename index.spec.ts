import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCodeVoice } from "./index"

type Toast = { message?: string; variant?: string }

const makeTmp = async () => {
  const dir = `/tmp/opencode-voice-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await mkdir(dir, { recursive: true })
  await mkdir(join(dir, ".opencode"), { recursive: true })
  return dir
}

describe("opencode-voice", () => {
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY
  })

  it("exports a plugin initializer", () => {
    expect(typeof OpenCodeVoice).toBe("function")
  })

  it("speaks once on session.idle and avoids re-speaking same message", async () => {
    const tmp = await makeTmp()
    await writeFile(
      join(tmp, ".opencode", "voice.json"),
      JSON.stringify({ enabled: true, mode: "continuous", voiceId: "voice", outputFormat: "mp3_44100_128" }),
    )

    process.env.ELEVENLABS_API_KEY = "key"

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any

    const toasts: Toast[] = []
    const client: any = {
      tui: {
        showToast: async (t: Toast) => {
          toasts.push(t)
          return { data: {} }
        },
      },
      session: {
        messages: async () => {
          return {
            data: [
              {
                info: { id: "m1", role: "assistant" },
                parts: [{ type: "text", text: "hello" }],
              },
            ],
          }
        },
      },
    }

    const $: any = () => ({
      nothrow: () => ({
        quiet: async () => ({ exitCode: 0, stderr: Buffer.from("") }),
      }),
    })

    const plugin = await OpenCodeVoice({ client, $, directory: tmp, worktree: undefined } as any)

    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as any)
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as any)

    expect(fetchCalls).toBe(1)

    await rm(tmp, { recursive: true, force: true })
  })

  it("queues a pending speak while already speaking", async () => {
    const tmp = await makeTmp()
    await writeFile(
      join(tmp, ".opencode", "voice.json"),
      JSON.stringify({ enabled: true, mode: "continuous", voiceId: "voice", outputFormat: "mp3_44100_128" }),
    )

    process.env.ELEVENLABS_API_KEY = "key"

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any

    const client: any = {
      tui: {
        showToast: async () => ({ data: {} }),
      },
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          const messageID = sessionID === "s1" ? "m1" : "m2"
          return {
            data: [
              {
                info: { id: messageID, role: "assistant" },
                parts: [{ type: "text", text: sessionID === "s1" ? "one" : "two" }],
              },
            ],
          }
        },
      },
    }

    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((r) => (startedResolve = r))

    let finishResolve: (() => void) | undefined
    const finish = new Promise<any>((r) => (finishResolve = r))

    let playCalls = 0
    const $: any = () => ({
      nothrow: () => ({
        quiet: async () => {
          playCalls++
          startedResolve?.()
          return await finish
        },
      }),
    })

    const plugin = await OpenCodeVoice({ client, $, directory: tmp, worktree: undefined } as any)

    const first = plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as any)
    await started

    const second = plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "s2" } } } as any)

    finishResolve?.({ exitCode: 0, stderr: Buffer.from("") })
    await first
    await second

    expect(fetchCalls).toBe(2)
    expect(playCalls).toBe(2)

    await rm(tmp, { recursive: true, force: true })
  })
})
