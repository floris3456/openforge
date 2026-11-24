import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { AgentThemePart } from "../config"
import { useTheme, useThemes } from "../context/theme"
import { AGENT_LABEL, AGENT_THEME, agentParts, agentStrengths } from "../theme/agent"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

// openforge (spec agent-theme): the agent theme's settings: its base theme, how strongly, and which parts follow the
// colour of the chat's agent. The screen shows the agent theme while this is open, a sample colour with no chat on
// screen; each change is saved as it is made.

type Row = { type: "use" } | { type: "base" } | { type: "strength" } | { type: "part"; key: AgentThemePart }

const help = {
  use: "Picks the agent theme, for this project inside a project and globally outside one, as the theme list does. Picking any other theme turns it off.",
  base: "The theme the agent theme starts from. Every colour that doesn't follow the agent stays this theme's, and status, diff and code colours always do.",
  strength:
    "How much of the agent's colour each part takes: subtle, clear or strong. Each colour keeps its lightness, so text stays as readable as in the base theme.",
}

// One line under the list for the selected row; `?` shows the whole help.
const short = {
  use: "For this project, or globally outside one",
  base: "Status, diff and code colours always stay its own",
  strength: "Each colour keeps its lightness",
}

/** `onClose` returns to the caller, e.g. Settings or the customizer, instead of closing every dialog. */
export function DialogThemeAgent(props: { onClose?: () => void; focus?: Row["type"] | AgentThemePart }) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const toast = useToast()
  const [ref, setRef] = createSignal<DialogSelectRef<Row>>()
  const reopen = (focus: Row["type"]) =>
    dialog.replace(() => <DialogThemeAgent onClose={props.onClose} focus={focus} />)

  onMount(() => themes.preview(AGENT_THEME))
  onCleanup(() => themes.preview(undefined))

  const where = () => {
    if (themes.own === AGENT_THEME) return "this project"
    if (!themes.own && themes.global === AGENT_THEME) return "global"
  }
  const options = createMemo(() => {
    const settings = themes.agent
    return [
      {
        title: "Use agent colours",
        value: { type: "use" } as Row,
        category: AGENT_LABEL,
        footer: where() ? `in use · ${where()}` : "",
        help: help.use,
      },
      {
        title: "Base theme",
        value: { type: "base" } as Row,
        category: AGENT_LABEL,
        footer: settings.base,
        help: help.base,
      },
      {
        title: "Strength",
        value: { type: "strength" } as Row,
        category: AGENT_LABEL,
        footer: settings.strength,
        help: help.strength,
      },
      ...agentParts.map((part) => ({
        title: part.title,
        value: { type: "part", key: part.key } as Row,
        category: "Takes the agent's colour",
        footer: settings.follow.includes(part.key) ? "follows" : "",
        help: part.help,
      })),
    ]
  })
  const selected = () => ref()?.selected?.value
  const selectedHelp = () => {
    const row = selected()
    if (!row) return
    if (row.type === "part") return agentParts.find((part) => part.key === row.key)?.help
    return short[row.type]
  }
  const current = options().find((option) => {
    const row = option.value
    return row.type === props.focus || (row.type === "part" && row.key === props.focus)
  })?.value

  return (
    <DialogSelect
      title={AGENT_LABEL}
      description={
        themes.chat
          ? "Parts you choose take the colour of this chat's agent"
          : "Parts you choose take the colour of the chat's agent; here a sample colour"
      }
      options={options()}
      current={current}
      preserveSelection
      ref={setRef}
      onCancel={props.onClose}
      footer={
        <Show when={selectedHelp()}>
          <text fg={theme.text.muted} wrapMode="word">
            {selectedHelp()}
          </text>
        </Show>
      }
      footerHints={[
        {
          title: (() => {
            const row = selected()
            if (row?.type === "part") return themes.agent.follow.includes(row.key) ? "stop following" : "follow"
            if (row?.type === "strength") return "change"
            if (row?.type === "base") return "choose"
            return "use"
          })(),
          label: "enter",
          group: "primary",
        },
      ]}
      onSelect={(option) => {
        const row = option.value
        const settings = themes.agent
        if (row.type === "use") {
          themes.set(AGENT_THEME)
          toast.show({
            variant: "success",
            message: themes.project
              ? `${themes.project.name} now uses ${AGENT_LABEL.toLowerCase()}`
              : `${AGENT_LABEL} is now the global theme`,
          })
          return
        }
        if (row.type === "strength")
          return themes.setAgent({
            strength: agentStrengths[(agentStrengths.indexOf(settings.strength) + 1) % agentStrengths.length],
          })
        if (row.type === "part")
          return themes.setAgent({
            follow: settings.follow.includes(row.key)
              ? settings.follow.filter((part) => part !== row.key)
              : agentParts.map((part) => part.key).filter((key) => key === row.key || settings.follow.includes(key)),
          })
        dialog.replace(() => <DialogAgentBase onDone={() => reopen("base")} />)
      }}
    />
  )
}

/** The base theme: moving shows the agent theme on it; Enter saves it. */
function DialogAgentBase(props: { onDone: () => void }) {
  const themes = useThemes()
  const names = Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  onMount(() => themes.preview(AGENT_THEME))
  onCleanup(() => {
    themes.previewAgent(undefined)
    themes.preview(undefined)
  })
  return (
    <DialogSelect
      title="Base theme"
      description={`The theme ${AGENT_LABEL.toLowerCase()} start from`}
      titlePlaceholder="Search themes"
      searchInTitle
      options={names.map((name) => ({ title: name, value: name, footer: themes.custom(name) ? "custom" : undefined }))}
      current={themes.agent.base}
      onMove={(option) => themes.previewAgent({ base: option.value })}
      onCancel={props.onDone}
      onSelect={(option) => {
        themes.setAgent({ base: option.value })
        props.onDone()
      }}
    />
  )
}
