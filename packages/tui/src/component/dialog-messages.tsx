import { createMemo, onMount } from "solid-js"
import { useData } from "../context/data"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { Locale } from "../util/locale"
import { myMessages } from "../util/my-messages"

// The "My messages" sidebar block's search dialog: a searchable list of every
// user message and answered question in the session, jumping the transcript
// on selection.
export function DialogMessages(props: { sessionID: string; onJump: (messageID: string) => void }) {
  const dialog = useDialog()
  const data = useData()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] =>
    myMessages(
      data.session.message.list(props.sessionID),
      data.session.get(props.sessionID)?.revert?.messageID,
    )
      .toReversed()
      .map((message) => ({
        title: message.text.replace(/\s+/g, " ").trim() || "(empty)",
        value: message.id,
        footer: Locale.time(message.created),
        onSelect: (ctx: DialogContext) => {
          props.onJump(message.id)
          ctx.clear()
        },
      })),
  )

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
