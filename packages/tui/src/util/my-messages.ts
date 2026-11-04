import type { SessionMessageInfo } from "@opencode/client"

// A "My messages" entry: what the user typed, or the answer they picked when
// the agent asked a question. Answers are not their own user message; they
// live in the question tool's metadata, so they are folded in here.
export type MyMessage = { readonly id: string; readonly text: string; readonly created: number }

// `metadata.answers` is one entry per question, each a list of the selected
// option labels. A single question renders its answer alone; several
// questions join their answers.
function answerText(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const answers = value
    .map((answer) => (Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : []))
    .map((answer) => answer.join(", "))
    .filter((answer) => answer.length > 0)
  if (answers.length === 0) return undefined
  return answers.join(" · ")
}

export function myMessages(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): MyMessage[] {
  const result: MyMessage[] = []
  for (const message of messages) {
    if (boundary && message.id >= boundary) continue
    if (message.type === "user") {
      result.push({ id: message.id, text: message.text, created: message.time.created })
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "question" || part.state.status !== "completed") continue
      const text = answerText(part.state.metadata?.answers)
      if (!text) continue
      result.push({ id: message.id, text, created: part.time.completed ?? part.time.created })
    }
  }
  return result
}
