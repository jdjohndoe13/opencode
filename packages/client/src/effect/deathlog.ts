import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Instrumentation build: a synchronous, always-flushed log of every event that can end a
 * process. The regular file logger batches writes for ~1s, so a SIGTERM-style kill (which
 * on Windows is TerminateProcess — no handler runs, no buffer flushes) erases the last
 * second of telemetry. This file writes each line with appendFileSync so the last words
 * always survive, and it is the only record of a death that leaves no other trace.
 *
 * Path: %TEMP%/opencode-death.log (or OPENCODE_DEATHLOG=<file> to override).
 */
const file = process.env.OPENCODE_DEATHLOG ?? path.join(os.tmpdir(), "opencode-death.log")

export const log = (event: string, data?: Record<string, unknown>) => {
  try {
    const detail = data === undefined ? "" : " " + JSON.stringify(data)
    fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${event}${detail}\n`)
  } catch {
    // never break the process for a diagnostic
  }
}

/**
 * Register the last-words handlers. Call once at process startup. `exit` fires on every
 * clean exit and on an uncatchable kill; a death with NO `exit` line means the process was
 * destroyed from outside (TerminateProcess / KillProcess / power loss) — SIGTERM on
 * Windows is that kind of kill and never reaches JS.
 */
export const install = (version?: string) => {
  log("start", { argv: process.argv.slice(2), version })
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, () => log(`signal ${signal}`))
    } catch {
      // platform may not support the signal
    }
  }
  process.on("exit", (code) => log("exit", { code }))
  process.on("beforeExit", (code) => log("beforeExit", { code }))
  process.on("uncaughtException", (err) => log("uncaughtException", { message: err?.message, stack: err?.stack }))
  process.on("unhandledRejection", (err) =>
    log("unhandledRejection", { message: err instanceof Error ? err.message : String(err) }),
  )
}

/** Record who called a function, so an external kill can be attributed to its caller. */
export const caller = (label: string, data?: Record<string, unknown>) => {
  const stack = new Error().stack?.split("\n").slice(2, 8).join(" | ")
  log(label, { ...data, stack })
}

export * as DeathLog from "./deathlog.js"
