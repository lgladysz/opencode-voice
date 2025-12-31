import { describe, expect, it } from "bun:test"
import { OpenCodeVoice } from "./index"

describe("opencode-voice", () => {
  it("exports a plugin initializer", () => {
    expect(typeof OpenCodeVoice).toBe("function")
  })
})
