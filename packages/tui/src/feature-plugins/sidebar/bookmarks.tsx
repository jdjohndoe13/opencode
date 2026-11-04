import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { sessionBookmarks, useBookmarks } from "../../context/bookmarks"
import { Locale } from "../../util/locale"

export function SidebarBookmarks(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const bookmarks = useBookmarks()
  const list = createMemo(() =>
    sessionBookmarks(bookmarks.entries(), props.sessionID)
      .toReversed()
      .filter((item) => props.context.data.session.message.get(props.sessionID, item.messageID)),
  )

  return (
    <Show when={list().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (list().length <= 2) return
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist bookmarks sidebar state", error))
          }}
        >
          <Show when={list().length > 2}>
            <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.base}>
            <b>Bookmarks</b>
            <Show when={!view.open}>
              <span style={{ fg: theme.text.muted }}> ({list().length})</span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || view.open}>
          <For each={list()}>
            {(item) => (
              <box
                flexDirection="row"
                gap={1}
                minWidth={0}
                onMouseUp={() => bookmarks.request(props.sessionID, item.messageID)}
              >
                <text flexShrink={0} fg={theme.text.feedback.warning.base}>
                  ★
                </text>
                <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                  {item.text || "(empty)"}
                </text>
                <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                  {Locale.time(item.created)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.bookmarks",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarBookmarks context={context} sessionID={props.sessionID} />,
    })
  },
})
