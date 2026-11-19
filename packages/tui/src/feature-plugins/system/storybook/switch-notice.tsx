import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { switchingNotice, type SwitchWork } from "@opencode/client/promise"
import { SwitchNotice } from "../../../component/switch-notice"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

// The same chats the notice counts, behind a transcript of the sort it used to cover.
const fixtures: { readonly title: string; readonly waiting: ReadonlyArray<SwitchWork> }[] = [
  { title: "one chat", waiting: [{ sessionID: "ses_a", kind: "tool", name: "webfetch" }] },
  {
    title: "three chats",
    waiting: [
      // A chat mid-reply reports its model call and its step; the notice still counts it once.
      { sessionID: "ses_a", kind: "model", name: "slow" },
      { sessionID: "ses_a", kind: "step", name: "reply" },
      { sessionID: "ses_b", kind: "step", name: "reply" },
      { sessionID: "ses_c", kind: "tool", name: "shell" },
    ],
  },
  {
    title: "chats and a command",
    waiting: [
      { sessionID: "ses_a", kind: "tool", name: "webfetch" },
      { sessionID: "ses_b", kind: "tool", name: "shell" },
      { kind: "step", name: "compaction" },
    ],
  },
]

function SwitchNoticeStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(1)
  const [version, setVersion] = createSignal<string | undefined>("0.0.60")
  const fixture = () => fixtures[index()]

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "n",
        title: "Next count",
        group: "Storybook",
        run: () => setIndex((value) => (value + 1) % fixtures.length),
      },
      {
        bind: "v",
        title: "Without a version, as another screen's switch",
        group: "Storybook",
        run: () => setVersion((value) => (value === undefined ? "0.0.60" : undefined)),
      },
      {
        bind: "r",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setIndex(1)
          setVersion("0.0.60")
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.base}>Build · GPT-5.6 Sol (high)</text>
        <text fg={theme.text.muted}>
          The transcript starts at the top of the screen, and the notice must not stand over these lines.
        </text>
        <text fg={theme.text.muted}>A second line the reader wants, with the prompt just below it.</text>
        <box flexGrow={1} />
        <box flexDirection="row" paddingRight={2}>
          <text fg={theme.text.muted}>┃ Ask anything…</text>
        </box>
      </box>
      <SwitchNotice message={switchingNotice(version(), fixture().waiting)} compact={switchingNotice(version())} />
      <StoryFooter
        context={props.context}
        title="storybook / switch notice"
        details={[fixture().title, `${dimensions().width} columns`]}
        message="One row at the bottom; n changes the count, v drops the version"
        controls={[
          { shortcut: "n", label: "next count" },
          { shortcut: "v", label: "version" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const switchNoticeStory: Story = {
  id: "switch-notice",
  title: "Switch notice",
  render: (context) => <SwitchNoticeStory context={context} />,
}
