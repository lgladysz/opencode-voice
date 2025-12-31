import type { Plugin } from "@opencode-ai/plugin"
import { isAbsolute, join } from "path"

type VoiceMode = "continuous" | "push-to-talk"

type VoiceConfig = {
  enabled?: boolean
  mode?: VoiceMode
  language?: string
  voiceId?: string
  modelId?: string
  outputFormat?: string
  player?: {
    cmd?: string
    args?: string[]
  }
}

const normalizePathForCompare = (p: string) => p.replace(/\\/g, "/")

const joinTextParts = (parts: any[]) => {
  const chunks: string[] = []
  for (const part of parts ?? []) {
    if (!part || part.type !== "text") continue
    if (part.ignored) continue
    const text = typeof part.text === "string" ? part.text : ""
    if (!text) continue
    chunks.push(text)
  }
  return chunks.join("").trim()
}

const defaultConfig = (partial?: VoiceConfig): Required<Pick<VoiceConfig, "enabled" | "mode" | "outputFormat" | "player">> &
  Omit<VoiceConfig, "enabled" | "mode" | "outputFormat" | "player"> => {
  return {
    enabled: partial?.enabled ?? true,
    mode: partial?.mode ?? "continuous",
    language: partial?.language,
    voiceId: partial?.voiceId,
    modelId: partial?.modelId,
    outputFormat: partial?.outputFormat ?? "mp3_44100_128",
    player: {
      cmd: partial?.player?.cmd ?? "mpv",
      args: partial?.player?.args ?? ["--no-terminal", "--force-window=no", "--keep-open=no"],
    },
  }
}

async function loadVoiceConfig(projectRoot: string): Promise<{ config: VoiceConfig; source: "project" | "global" | "none" }>
{
  const home = process.env["HOME"]
  const projectPath = join(projectRoot, ".opencode", "voice.json")
  const globalPath = home ? join(home, ".config", "opencode", "voice.json") : undefined

  const projectFile = Bun.file(projectPath)
  if (await projectFile.exists()) {
    const raw = await projectFile.text()
    return { config: JSON.parse(raw) as VoiceConfig, source: "project" }
  }

  if (globalPath) {
    const globalFile = Bun.file(globalPath)
    if (await globalFile.exists()) {
      const raw = await globalFile.text()
      return { config: JSON.parse(raw) as VoiceConfig, source: "global" }
    }
  }

  return { config: {}, source: "none" }
}

async function elevenLabsTts(params: {
  apiKey: string
  voiceId: string
  text: string
  modelId: string
  outputFormat: string
}): Promise<Uint8Array> {
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(params.voiceId)}/stream`)
  url.searchParams.set("output_format", params.outputFormat)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": params.apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: params.text,
      model_id: params.modelId,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(body || `ElevenLabs request failed: ${res.status} ${res.statusText}`)
  }

  return new Uint8Array(await res.arrayBuffer())
}

export const OpenCodeVoice: Plugin = async ({ client, $, directory, worktree }) => {
  const projectRoot = worktree || directory

  const state = {
    config: defaultConfig(),
    configSource: "none" as "project" | "global" | "none",
    lastSessionID: undefined as string | undefined,
    disabledSessions: new Set<string>(),
    lastSpokenAssistantMessage: new Map<string, string>(),
    speaking: false,
  }

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    await client.tui.showToast({ message, variant }).catch(() => {})
  }

  const reloadConfig = async () => {
    try {
      const loaded = await loadVoiceConfig(projectRoot)
      state.config = defaultConfig(loaded.config)
      state.configSource = loaded.source
      await toast(
        `Voice config loaded (${loaded.source}). mode=${state.config.mode} enabled=${state.config.enabled ? "on" : "off"}`,
        "success",
      )
    } catch (e) {
      await toast(`Voice config error: ${(e as Error).message}`, "error")
    }
  }

  const isEnabledForSession = (sessionID: string) => {
    if (!state.config.enabled) return false
    if (state.disabledSessions.has(sessionID)) return false
    return true
  }

  const getLatestAssistant = async (sessionID: string) => {
    const list = await client.session.messages({ sessionID, limit: 25 })
    const messages = (list.data ?? []) as Array<{ info: any; parts: any[] }>
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg?.info) continue
      if (msg.info.role !== "assistant") continue
      const text = joinTextParts(msg.parts)
      if (!text) continue
      return { messageID: msg.info.id as string, text }
    }
    return undefined
  }

  const playAudio = async (bytes: Uint8Array) => {
    const tmp = process.env["TMPDIR"] || "/tmp"
    const filename = `opencode-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`
    const filePath = join(tmp, filename)
    await Bun.write(filePath, bytes)

    const cmd = state.config.player.cmd
    const args = state.config.player.args

    if (!cmd) throw new Error("Missing player.cmd")

    const result = await $`${{ raw: cmd }} ${args ?? []} ${filePath}`.nothrow().quiet()
    await Bun.file(filePath).delete().catch(() => {})

    if (result.exitCode !== 0) {
      const stderr = result.stderr?.toString() ?? ""
      throw new Error(stderr.trim() || `Player exited with code ${result.exitCode}`)
    }
  }

  const speakSession = async (sessionID: string, reason: "idle" | "manual") => {
    if (!isEnabledForSession(sessionID)) return
    if (state.speaking) return

    const apiKey = process.env["ELEVENLABS_API_KEY"]
    if (!apiKey) {
      await toast("Missing ELEVENLABS_API_KEY", "error")
      return
    }

    const voiceId = state.config.voiceId
    if (!voiceId) {
      await toast("Missing voiceId in voice.json", "error")
      return
    }

    const modelId = state.config.modelId || (state.config.language ? "eleven_multilingual_v2" : "eleven_turbo_v2_5")

    state.speaking = true
    try {
      const latest = await getLatestAssistant(sessionID)
      if (!latest) return

      if (reason === "idle") {
        const last = state.lastSpokenAssistantMessage.get(sessionID)
        if (last === latest.messageID) return
      }

      const bytes = await elevenLabsTts({
        apiKey,
        voiceId,
        text: latest.text,
        modelId,
        outputFormat: state.config.outputFormat,
      })

      await playAudio(bytes)

      state.lastSpokenAssistantMessage.set(sessionID, latest.messageID)
    } catch (e) {
      await toast(`Voice error: ${(e as Error).message}`, "error")
    } finally {
      state.speaking = false
    }
  }

  await reloadConfig()

  const handleCommand = async (command: string) => {
    const sessionID = state.lastSessionID

    if (command === "voice.reload") {
      await reloadConfig()
      return
    }

    if (command === "voice.status") {
      const effective = sessionID ? (isEnabledForSession(sessionID) ? "on" : "off") : state.config.enabled ? "on" : "off"
      await toast(`Voice ${effective}. mode=${state.config.mode}. source=${state.configSource}`, "info")
      return
    }

    if (command === "voice.mode.continuous") {
      state.config.mode = "continuous"
      await toast("Voice mode: continuous", "success")
      return
    }

    if (command === "voice.mode.push-to-talk") {
      state.config.mode = "push-to-talk"
      await toast("Voice mode: push-to-talk", "success")
      return
    }

    if (command === "voice.speak") {
      if (!sessionID) {
        await toast("No active session to speak", "warning")
        return
      }
      await speakSession(sessionID, "manual")
      return
    }

    if (command === "voice.on" || command === "voice.off" || command === "voice.toggle") {
      if (!sessionID) {
        if (command === "voice.toggle") state.config.enabled = !state.config.enabled
        if (command === "voice.on") state.config.enabled = true
        if (command === "voice.off") state.config.enabled = false
        await toast(`Voice ${state.config.enabled ? "on" : "off"} (global)`, "success")
        return
      }

      const currentlyOn = isEnabledForSession(sessionID)
      const nextOn =
        command === "voice.on" ? true : command === "voice.off" ? false : command === "voice.toggle" ? !currentlyOn : currentlyOn

      if (nextOn) state.disabledSessions.delete(sessionID)
      else state.disabledSessions.add(sessionID)

      await toast(`Voice ${nextOn ? "on" : "off"} (session)`, "success")
      return
    }
  }

  return {
    event: async ({ event }) => {
      const payload = (event as any).payload ?? event
      if (!payload?.type) return

      if (payload.type === "session.idle") {
        const sessionID = payload.properties?.sessionID as string | undefined
        if (sessionID) state.lastSessionID = sessionID
        if (sessionID && state.config.mode === "continuous") {
          await speakSession(sessionID, "idle")
        }
        return
      }

      if (payload.type === "message.updated") {
        const sessionID = payload.properties?.info?.sessionID as string | undefined
        if (sessionID) state.lastSessionID = sessionID
        return
      }

      if (payload.type === "tui.command.execute") {
        const cmd = payload.properties?.command as string | undefined
        if (!cmd) return
        if (!cmd.startsWith("voice.")) return
        await handleCommand(cmd)
        return
      }

      if (payload.type === "file.watcher.updated") {
        const file = payload.properties?.file as string | undefined
        if (!file) return

        const normalized = normalizePathForCompare(file)
        const projectConfig = normalizePathForCompare(join(projectRoot, ".opencode", "voice.json"))

        const home = process.env["HOME"]
        const globalConfig = home ? normalizePathForCompare(join(home, ".config", "opencode", "voice.json")) : undefined

        const samePath = (candidate: string) => {
          if (isAbsolute(candidate)) return normalizePathForCompare(candidate) === normalized
          return normalizePathForCompare(join(projectRoot, candidate)) === normalized
        }

        if (samePath(projectConfig) || (globalConfig && samePath(globalConfig))) {
          await reloadConfig()
        }
        return
      }
    },
  }
}
