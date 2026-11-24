import { TextAttributes } from "@opentui/core"
import { onCleanup } from "solid-js"
import { useNewDesigns } from "../config"
import { useTheme, useThemes } from "../context/theme"
import { AGENT_LABEL, AGENT_THEME, themeLabel } from "../theme/agent"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"

const GLOBAL = "\u0000global"

/**
 * openforge (spec project-themes): inside a project Enter sets that project's theme, and the first row returns it to the
 * global theme; outside a project, or with `scope` "global", Enter sets the global theme. Moving and searching only
 * preview on this screen; nothing is written until Enter. `onClose` returns to the caller, e.g. Settings, instead of
 * closing every dialog.
 */
export function DialogThemeList(props: { onClose?: () => void; scope?: "global" }) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const dialog = useDialog()
  const project = props.scope === "global" ? undefined : themes.project
  const global = themes.global
  const own = themes.own
  const names = Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  // openforge (spec agent-theme): the agent theme comes first after the global row, as the special entry it is.
  const options = [
    ...(project ? [{ title: `Global theme (${themeLabel(global)})`, value: GLOBAL }] : []),
    { title: AGENT_LABEL, value: AGENT_THEME, footer: global === AGENT_THEME ? "global" : "agent" },
    ...names.map((name) => ({
      title: name,
      value: name,
      footer: name === global ? "global" : themes.custom(name) ? "custom" : undefined,
    })),
  ]
  const description = (() => {
    if (project)
      return own
        ? `${project.name} uses its own theme · global: ${themeLabel(global)}`
        : `${project.name} uses the global theme`
    const shown = themes.project
    if (props.scope === "global" && shown && themes.own)
      return `Global theme · ${shown.name} keeps its own: ${themeLabel(themes.own)}`
    return "Global theme"
  })()
  const target = (value: string) => (value === GLOBAL ? global : value)
  // In a project, the global theme's own row returns the project to the global theme as the first row does, so a
  // project's own theme is never the global one under another name.
  const choose = (value: string) => {
    if (!project) return themes.setGlobal(value)
    if (target(value) === global) return themes.useGlobal()
    return themes.set(value)
  }
  let ref: DialogSelectRef<string>

  onCleanup(() => themes.preview(undefined))

  return (
    <DialogSelect
      title="Themes"
      titleView={
        newDesigns() ? undefined : (
          <box>
            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
              Themes
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              {description}
            </text>
          </box>
        )
      }
      description={description}
      searchInTitle={!project}
      titlePlaceholder="Search themes"
      options={options}
      current={project ? (own ?? GLOBAL) : global}
      onCancel={props.onClose}
      onMove={(option) => themes.preview(target(option.value))}
      onSelect={(option) => {
        choose(option.value)
        if (props.onClose) return props.onClose()
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        const first = query.length ? ref.filtered[0] : undefined
        themes.preview(first ? target(first.value) : undefined)
      }}
    />
  )
}
