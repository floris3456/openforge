import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { SessionMessageInfo } from "@opencode/client"
import { MemoryLines } from "@opencode/util/memory-lines"
import { useTheme } from "../../context/theme"
import { INLINE_TOOL_ICON_WIDTH, InlineToolRow } from "./message-parts"

// openforge: a notice line opens to what its message gave the chat (spec notice-view). Only the view reads the stored
// text; what the model gets is unchanged. A decision, the person's ruling, reads as the dashboard labels it: his
// decision (workspace spec decisions-in-memory).

type Block =
  | { readonly type: "entry"; readonly entry: MemoryLines.Entry }
  | { readonly type: "text"; readonly text: string; readonly muted: boolean }

/** A notice's line, and below it, once clicked, its message's text: memory's entries one block each. */
export function NoticeLine(props: { message: SessionMessageInfo; icon: string; description: string }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const view = createMemo(() => noticeView(props.message, props.description))
  const count = () => view()?.blocks.filter((block) => block.type === "entry").length ?? 0
  return (
    <>
      <InlineToolRow
        icon={props.icon}
        color={hover() && view() ? theme.text.base : theme.text.muted}
        pending="Notice"
        complete={true}
        onMouseOver={() => view() && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (!view() || renderer.getSelection()?.getSelectedText()) return
          setExpanded((value) => !value)
        }}
      >
        {props.description}
        {count() ? ` · ${count()} ${count() === 1 ? "entry" : "entries"}` : ""}
      </InlineToolRow>
      <Show when={expanded() && view()}>
        {(open) => (
          <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH} flexDirection="column" gap={1}>
            <For each={open().blocks}>
              {(block) => (
                <Switch>
                  <Match when={block.type === "entry" && block.entry}>
                    {(entry) => (
                      <box flexDirection="column">
                        <text wrapMode="word">
                          <span style={{ fg: theme.text.base }}>{entry().id}</span>
                          <Show
                            when={entry().kind === "decision"}
                            fallback={
                              <span style={{ fg: theme.text.muted }}>
                                {"  "}
                                {entry().author} · {entry().scope} · {entry().day}
                              </span>
                            }
                          >
                            <span style={{ fg: theme.text.base }}>{"  "}his decision</span>
                            <span style={{ fg: theme.text.muted }}>
                              {" · "}
                              of {entry().person}, noted as {entry().role}
                              {entry().task ? `, in task ${entry().task}` : ""} · {entry().scope} · {entry().day}
                            </span>
                          </Show>
                        </text>
                        <text fg={theme.text.base} wrapMode="word">
                          {entry().text}
                        </text>
                        <Show when={entry().basis}>
                          {(basis) => (
                            <text fg={theme.text.muted} wrapMode="word">
                              basis: {basis()}
                            </text>
                          )}
                        </Show>
                      </box>
                    )}
                  </Match>
                  <Match when={block.type === "text" && block}>
                    {(text) => (
                      <text fg={text().muted ? theme.text.muted : theme.text.base} wrapMode="word">
                        {text().text}
                      </text>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </box>
        )}
      </Show>
    </>
  )
}

/**
 * What an open notice shows: its text without the `<system-reminder>` tags, laid out in blocks; `undefined` when the
 * text says no more than the line, which then does not open.
 */
function noticeView(message: SessionMessageInfo, description: string) {
  if (message.type !== "synthetic" && message.type !== "system") return
  const body = message.text
    .trim()
    .replace(/^<system-reminder>\s*/, "")
    .replace(/\s*<\/system-reminder>$/, "")
    .trim()
  if (!body || body === description.trim()) return
  const memory = message.metadata?.memory !== undefined || message.metadata?.memoryPrompt !== undefined
  if (!memory) return { blocks: [{ type: "text", text: body, muted: false }] satisfies Block[] }
  // Lines that are not entries stay together, in their order, between the entries.
  const blocks = MemoryLines.lines(body).reduce<Block[]>((list, line) => {
    const last = list.at(-1)
    if (line.type === "entry") return [...list, { type: "entry", entry: line.entry }]
    if (last?.type === "text") return [...list.slice(0, -1), { ...last, text: `${last.text}\n${line.text}` }]
    return [...list, { type: "text", text: line.text, muted: true }]
  }, [])
  return { blocks }
}
