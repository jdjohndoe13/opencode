import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { useBookmarks } from "../../context/bookmarks"
import { DialogMessages } from "../../component/dialog-messages"
import { Locale } from "../../util/locale"

// Rows the list shows before the nested scroll takes over; the sidebar column
// is short, so a long transcript must not push the rest of the panel down.
const MY_MESSAGES_VISIBLE = 10

export function SidebarMyMessages(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const bookmarks = useBookmarks()
  const [searchHover, setSearchHover] = createSignal(false)
  const openSearch = () =>
    props.context.ui.dialog.show(() => (
      <DialogMessages
        sessionID={props.sessionID}
        onJump={(messageID) => bookmarks.request(props.sessionID, messageID)}
      />
    ))
  const list = createMemo(() => {
    const boundary = props.context.data.session.get(props.sessionID)?.revert?.messageID
    const result: { id: string; text: string; created: number }[] = []
    for (const message of props.context.data.session.message.list(props.sessionID)) {
      if (message.type !== "user") continue
      if (boundary && message.id >= boundary) continue
      result.push({ id: message.id, text: message.text, created: message.time.created })
    }
    return result.toReversed()
  })

  return (
    <Show when={list().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist my-messages sidebar state", error))
          }}
        >
          <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          <text fg={theme.text.base} wrapMode="none">
            <b>My messages</b>
          </text>
          <box
            onMouseDown={(event: { stopPropagation(): void }) => event.stopPropagation()}
            onMouseOver={() => setSearchHover(true)}
            onMouseOut={() => setSearchHover(false)}
            onMouseUp={(event: { stopPropagation(): void }) => {
              event.stopPropagation()
              openSearch()
            }}
          >
            <text
              width={1}
              height={1}
              wrapMode="none"
              selectable={false}
              fg={searchHover() ? theme.text.base : theme.text.action.secondary.base}
            >
              ⌕
            </text>
          </box>
          <text fg={theme.text.muted} wrapMode="none">
            ({list().length})
          </text>
        </box>
        <Show when={view.open}>
          <scrollbox maxHeight={MY_MESSAGES_VISIBLE} scrollbarOptions={{ visible: false }}>
            <For each={list()}>
              {(message) => (
                <box
                  flexDirection="row"
                  gap={1}
                  minWidth={0}
                  onMouseUp={() => bookmarks.request(props.sessionID, message.id)}
                >
                  <text flexShrink={0} fg={theme.text.muted}>
                    ›
                  </text>
                  <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                    {message.text.replace(/\s+/g, " ").trim() || "(empty)"}
                  </text>
                  <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                    {Locale.time(message.created)}
                  </text>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.my-messages",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarMyMessages context={context} sessionID={props.sessionID} />,
    })
  },
})
