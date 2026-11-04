import { createMemo, onMount } from "solid-js"
import { useData } from "../context/data"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { Locale } from "../util/locale"

// The "My messages" sidebar block's search dialog: a searchable list of every
// user message in the session, jumping the transcript on selection.
export function DialogMessages(props: { sessionID: string; onJump: (messageID: string) => void }) {
  const dialog = useDialog()
  const data = useData()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const boundary = data.session.get(props.sessionID)?.revert?.messageID
    const result = [] as DialogSelectOption<string>[]
    for (const message of data.session.message.list(props.sessionID)) {
      if (message.type !== "user") continue
      if (boundary && message.id >= boundary) continue
      result.push({
        title: message.text.replace(/\s+/g, " ").trim() || "(empty)",
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (ctx: DialogContext) => {
          props.onJump(message.id)
          ctx.clear()
        },
      })
    }
    return result.toReversed()
  })

  return (
    <DialogSelect
      onMove={(option) => props.onJump(option.value)}
      title="My messages"
      searchInTitle
      titlePlaceholder="Search my messages"
      placeholder="Search my messages"
      options={options()}
    />
  )
}
