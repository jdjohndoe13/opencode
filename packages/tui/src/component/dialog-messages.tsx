import { createMemo, onMount } from "solid-js"
import { useBookmarks } from "../context/bookmarks"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { Locale } from "../util/locale"

// The "My messages" sidebar block's search dialog: a searchable list of every
// user message and answered question in the session, jumping the transcript
// on selection. The server projects both into its own rows.
export function DialogMessages(props: { sessionID: string; onJump: (messageID: string) => void }) {
  const dialog = useDialog()
  const bookmarks = useBookmarks()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] =>
    bookmarks
      .myMessages(props.sessionID)
      .toReversed()
      .map((message) => ({
        title: message.text.replace(/\s+/g, " ").trim() || "(empty)",
        value: message.messageID,
        footer: Locale.time(message.created),
        onSelect: (ctx: DialogContext) => {
          props.onJump(message.messageID)
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
