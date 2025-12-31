# opencode-voice

OpenCode plugin that reads assistant responses aloud via **ElevenLabs TTS**.

## Install

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-voice"
  ]
}
```

Set your ElevenLabs API key:

```bash
export ELEVENLABS_API_KEY="..."
```

## Configuration

Create either:

- Project config: `<project>/.opencode/voice.json`
- Global config: `~/.config/opencode/voice.json`

Example:

```json
{
  "enabled": true,
  "mode": "continuous",
  "language": "pl-PL",
  "voiceId": "YOUR_ELEVENLABS_VOICE_ID",
  "modelId": "eleven_multilingual_v2",
  "outputFormat": "mp3_44100_128",
  "player": {
    "cmd": "mpv",
    "args": ["--no-terminal", "--force-window=no", "--keep-open=no"]
  }
}
```

Notes:
- `mode: "continuous"` speaks automatically on `session.idle`.
- `mode: "push-to-talk"` never auto-speaks; use `voice.speak`.

## Commands (plugin-only)

These are handled server-side by the plugin (no OpenCode core changes required).
Trigger them via OpenCode HTTP API:

```bash
curl -s http://localhost:4096/tui/execute-command \
  -H 'content-type: application/json' \
  -d '{"command":"voice.toggle"}'
```

Supported commands:
- `voice.toggle` / `voice.on` / `voice.off` (per-session if a session was recently active; otherwise global)
- `voice.speak` (speak last assistant message once)
- `voice.mode.continuous`
- `voice.mode.push-to-talk`
- `voice.status`
- `voice.reload`

## Linux dependencies

Recommended player: `mpv`.

Alternative: `ffplay` (from ffmpeg), e.g. set:

```json
{
  "player": {
    "cmd": "ffplay",
    "args": ["-nodisp", "-autoexit", "-loglevel", "error"]
  }
}
```

## Development

```bash
bun install
bun test
bun run build
```

## License

MIT
