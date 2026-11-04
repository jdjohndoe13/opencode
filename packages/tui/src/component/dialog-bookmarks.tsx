import { createMemo, onMount } from "solid-js"
import { sessionBookmarks, useBookmarks } from "../context/bookmarks"
import { useData } from "../context/data"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { Locale } from "../util/locale"

// The sidebar bookmarks block's search dialog: a searchable list of the
// session's bookmarks, mirroring the timeline's search-to-jump behavior.
export function DialogBookmarks(props: { sessionID: string; onJump: (messageID: string) => void }) {
  const dialog = useDialog()
  const data = useData()
  const bookmarks = useBookmarks()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] =>
    sessionBookmarks(bookmarks.entries(), props.sessionID)
      .toReversed()
      .filter((item) => data.session.message.get(props.sessionID, item.messageID))
      .map((item) => ({
        title: item.text.replace(/\s+/g, " ").trim() || "(empty)",
        value: item.messageID,
        footer: Locale.time(item.created),
        onSelect: (ctx: DialogContext) => {
          props.onJump(item.messageID)
          ctx.clear()
        },
      })),
  )

  return (
    <DialogSelect
      onMove={(option) => props.onJump(option.value)}
      title="Bookmarks"
      searchInTitle
      titlePlaceholder="Search bookmarks"
      placeholder="Search bookmarks"
      options={options()}
    />
  )
}
