import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelsDev } from "@opencode/core/models-dev"

const snapshot = require("fs").readFileSync(`${import.meta.dir}/../src/models-dev/snapshot.txt`, "utf8") as string

const opencodeInference = /^https:\/\/(?:[a-z0-9-]+\.)*opencode\.ai\/inference\//i

describe("local safety patch: opencode.ai inference sandboxed", () => {
  const entries = Effect.runSync(ModelsDev.decodeSnapshot(snapshot))

  test("no provider or model keeps an opencode.ai inference URL", () => {
    const leaked: string[] = []
    for (const entry of entries) {
      if (entry.info.settings?.baseURL && opencodeInference.test(entry.info.settings.baseURL))
        leaked.push(`provider ${entry.info.id}: ${entry.info.settings.baseURL}`)
      for (const model of entry.models)
        if (model.settings?.baseURL && opencodeInference.test(model.settings.baseURL))
          leaked.push(`model ${entry.info.id}/${model.id}: ${model.settings.baseURL}`)
    }
    expect(leaked).toEqual([])
  })

  test("big-pickle points at the dead loopback and is renamed", () => {
    const opencode = entries.find((entry) => entry.info.id === "opencode")
    const pickle = opencode?.models.find((model) => model.id === "big-pickle")
    expect(opencode?.info.settings?.baseURL).toBe("http://127.0.0.1:1")
    expect(pickle?.name).toBe("LLM configuration error")
  })

  test("non-opencode providers are untouched", () => {
    const anthropic = entries.find((entry) => entry.info.id === "anthropic")
    const model = anthropic?.models.find((m) => m.settings?.baseURL || true)
    expect(model?.settings?.baseURL === undefined || !model.settings.baseURL.includes("127.0.0.1:1")).toBe(true)
  })

  test("v1 catalogs are sandboxed too", () => {
    const v1 = JSON.stringify({
      acme: {
        id: "acme",
        name: "Acme",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        api: "https://opencode.ai/inference/openai/v1",
        models: {
          "m1": {
            id: "m1",
            name: "M1",
            release_date: "2026-01-01",
            cost: { input: 0, output: 0 },
          },
        },
      },
    })
    const [acme] = Effect.runSync(ModelsDev.decodeSnapshot(v1))
    expect(acme?.info.settings?.baseURL).toBe("http://127.0.0.1:1")
    expect(acme?.models[0]?.name).toBe("LLM configuration error")
  })
})
