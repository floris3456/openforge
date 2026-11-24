import { RGBA } from "@opentui/core"
import type { ThemeColor, ThemeV1Json } from "@opencode/theme/tui/v1"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme, useThemes } from "../context/theme"
import { copyTheme, nameProblem, parseHex, roleColor, roles, setRole } from "../theme/custom"
import { formats, importScheme } from "../theme/import"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

// openforge (spec custom-themes): your own themes, each a file in the global themes folder. A theme that isn't yours is
// copied into one under a name you give; an imported scheme becomes one. Editing a theme shows it on the screen and
// saves each colour as you set it.

type Choice = { type: "import" } | { type: "edit"; name: string } | { type: "copy"; name: string }

/** `onClose` returns to the caller, e.g. Settings, instead of closing every dialog. */
export function DialogThemeCustomize(props: { onClose?: () => void; focus?: string }) {
  const themes = useThemes()
  const dialog = useDialog()
  const names = Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  const back = () => dialog.replace(() => <DialogThemeCustomize onClose={props.onClose} focus={props.focus} />)
  const options = [
    { title: "Import a colour scheme…", value: { type: "import" } as Choice, category: "New" },
    ...names
      .filter((name) => themes.custom(name))
      .map((name) => ({ title: name, value: { type: "edit", name } as Choice, category: "Your themes" })),
    ...names
      .filter((name) => !themes.custom(name))
      .map((name) => ({
        title: name,
        value: { type: "copy", name } as Choice,
        category: "Copy into a theme of your own",
      })),
  ]
  const current = options.find((option) => option.value.type !== "import" && option.value.name === props.focus)?.value

  return (
    <DialogSelect
      title="Customize themes"
      description="Pick one of your themes to edit, a theme to copy into one of your own, or import a scheme"
      options={options}
      current={current}
      onCancel={props.onClose}
      onSelect={(option) => {
        const choice = option.value
        if (choice.type === "edit") return openEditor(dialog, choice.name, props.onClose)
        if (choice.type === "import")
          return dialog.replace(() => <DialogImport onClose={props.onClose} onCancel={back} />)
        dialog.replace(() => (
          <DialogName
            title={`Copy ${choice.name}`}
            value={freeName(`${choice.name} copy`, themes.has)}
            onCancel={back}
            onConfirm={async (name) => {
              await themes.saveCustom(name, copyTheme(themes.all()[choice.name]!, choice.name))
              openEditor(dialog, name, props.onClose)
            }}
          />
        ))
      }}
    />
  )
}

function openEditor(dialog: DialogContext, name: string, onClose?: () => void, focus?: string) {
  dialog.replace(() => <DialogThemeEditor name={name} onClose={onClose} focus={focus} />)
}

type Row = { type: "use" } | { type: "rename" } | { type: "delete" } | { type: "role"; key: ThemeColor }

function DialogThemeEditor(props: { name: string; onClose?: () => void; focus?: string }) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const toast = useToast()
  const mode = themes.mode()
  const source = () => themes.all()[props.name] as ThemeV1Json | undefined
  const [selected, setSelected] = createSignal(roles.find((role) => role.key === props.focus) ?? roles[0]!)
  const reopen = (focus?: string) => openEditor(dialog, props.name, props.onClose, focus)
  const back = () => dialog.replace(() => <DialogThemeCustomize onClose={props.onClose} focus={props.name} />)

  onMount(() => themes.preview(props.name))
  onCleanup(() => themes.preview(undefined))

  const color = (key: ThemeColor) => {
    const theme = source()
    return theme ? roleColor(theme, key, mode) : undefined
  }
  const options = [
    { title: "Use this theme", value: { type: "use" } as Row, category: props.name },
    { title: "Rename…", value: { type: "rename" } as Row, category: props.name },
    { title: "Delete…", value: { type: "delete" } as Row, category: props.name },
    ...roles.map((role) => {
      const value = color(role.key)
      return {
        title: role.title,
        value: { type: "role", key: role.key } as Row,
        category: `${role.group} (${mode})`,
        help: role.help,
        // Inside the row's own text: spans only.
        footer: value ? (
          <>
            <span style={{ fg: RGBA.fromHex(value) }}>██</span>
            <span>{` ${value}`}</span>
          </>
        ) : undefined,
      }
    }),
  ]

  return (
    <DialogSelect
      title={`Edit ${props.name}`}
      description={`Each colour is saved as you set it, for the ${mode} mode`}
      options={options}
      current={props.focus ? options.find((option) => option.value.type === "role" && option.value.key === props.focus)?.value : undefined}
      onCancel={back}
      onMove={(option) => {
        const row = option.value
        if (row.type === "role") setSelected(roles.find((role) => role.key === row.key)!)
      }}
      footer={
        <text fg={theme.text.muted} wrapMode="word">
          {selected().title}: {selected().help}
        </text>
      }
      onSelect={(option) => {
        const row = option.value
        if (row.type === "use") {
          themes.set(props.name)
          toast.show({
            variant: "success",
            message: themes.project ? `${themes.project.name} now uses ${props.name}` : `${props.name} is now the global theme`,
          })
          return
        }
        if (row.type === "rename")
          return dialog.replace(() => (
            <DialogName
              title={`Rename ${props.name}`}
              value={props.name}
              allow={props.name}
              onCancel={() => reopen()}
              onConfirm={async (name) => {
                if (name !== props.name) await themes.renameCustom(props.name, name)
                openEditor(dialog, name, props.onClose)
              }}
            />
          ))
        if (row.type === "delete")
          return dialog.replace(() => (
            <DialogSelect
              title={`Delete ${props.name}?`}
              description="Its file goes from the themes folder; a project or the global theme that used it takes the next theme in line"
              options={[
                { title: "Keep it", value: false },
                { title: `Delete ${props.name}`, value: true },
              ]}
              onCancel={() => reopen()}
              onSelect={async (choice) => {
                if (!choice.value) return reopen()
                await themes.removeCustom(props.name).catch(toast.error)
                dialog.replace(() => <DialogThemeCustomize onClose={props.onClose} />)
              }}
            />
          ))
        const role = roles.find((role) => role.key === row.key)!
        dialog.replace(() => (
          <DialogColor
            title={`${role.title} (${mode})`}
            value={color(role.key) ?? ""}
            onCancel={() => reopen(role.key)}
            onConfirm={async (value) => {
              const theme = source()
              if (!theme) return reopen(role.key)
              await themes.saveCustom(props.name, setRole(theme, role.key, mode, value))
              reopen(role.key)
            }}
          />
        ))
      }}
    />
  )
}

/** A colour typed as a hex, or the name of another role whose colour it takes. */
function DialogColor(props: {
  title: string
  value: string
  onConfirm: (color: string) => Promise<void>
  onCancel: () => void
}) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const [problem, setProblem] = createSignal<string>()
  return (
    <DialogPrompt
      title={props.title}
      value={props.value}
      placeholder="#rrggbb, or another colour's name such as Primary"
      description={() => (
        <Show when={problem()}>
          <text fg={theme.text.feedback.error.base}>{problem()}</text>
        </Show>
      )}
      onCancel={props.onCancel}
      onConfirm={(input) => {
        const named = roles.find(
          (role) => role.title.toLowerCase() === input.trim().toLowerCase() || role.key === input.trim(),
        )
        const source = themes.all()[themes.selected] as ThemeV1Json | undefined
        const value = parseHex(input) ?? (named && source ? roleColor(source, named.key, themes.mode()) : undefined)
        if (!value) return setProblem("Type a colour such as #1e1e2e, or the name of another colour such as Primary")
        void props.onConfirm(value).catch((error) => setProblem(String(error)))
      }}
    />
  )
}

/** A custom theme's name: new, short and plain; `allow` is the name it already has. */
function DialogName(props: {
  title: string
  value: string
  allow?: string
  onConfirm: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const [problem, setProblem] = createSignal<string>()
  return (
    <DialogPrompt
      title={props.title}
      value={props.value}
      placeholder="Name of your theme"
      description={() => (
        <Show when={problem()}>
          <text fg={theme.text.feedback.error.base}>{problem()}</text>
        </Show>
      )}
      onCancel={props.onCancel}
      onConfirm={(input) => {
        const name = input.trim()
        const found = nameProblem(name, (name) => name !== props.allow && (themes.has(name) || name === "agent"))
        if (found) return setProblem(found)
        void props.onConfirm(name).catch((error) => setProblem(String(error)))
      }}
    />
  )
}

/** Paste a scheme, or give a file or a web address that holds one; then name the theme it becomes. */
function DialogImport(props: { onClose?: () => void; onCancel: () => void }) {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogPrompt
      title="Import a colour scheme"
      placeholder="Paste a scheme, or a file path or web address"
      busy={busy()}
      busyText="Reading the scheme…"
      description={() => (
        <box>
          <text fg={theme.text.muted} wrapMode="word">
            Takes {formats}.
          </text>
          <Show when={problem()}>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {problem()}
            </text>
          </Show>
        </box>
      )}
      onCancel={props.onCancel}
      onConfirm={(input) => {
        setBusy(true)
        void schemeText(input)
          .then(importScheme)
          .then((imported) =>
            dialog.replace(() => (
              <DialogName
                title={`Name the ${imported.format} scheme`}
                value={freeName(imported.name ?? "imported", themes.has)}
                onCancel={props.onCancel}
                onConfirm={async (name) => {
                  await themes.saveCustom(name, imported.theme)
                  openEditor(dialog, name, props.onClose)
                }}
              />
            )),
          )
          .catch((error: Error) => {
            setBusy(false)
            setProblem(error.message)
          })
      }}
    />
  )
}

// What was typed: a web address is fetched (a GitHub page as its raw file), a path to a file is read, else it is the
// scheme itself.
async function schemeText(input: string) {
  const text = input.trim()
  if (/^https?:\/\/\S+$/.test(text)) {
    const url = text.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/")
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.text()
  }
  if (!text.includes("\n") && /^(~|\.{0,2}\/)/.test(text)) {
    const file = text.startsWith("~") ? path.join(os.homedir(), text.slice(1)) : path.resolve(text)
    return readFile(file, "utf8").catch(() => {
      throw new Error(`No file at ${file}`)
    })
  }
  return text
}

/** `base`, or `base 2`, `base 3` … : the first name no theme has. */
function freeName(base: string, taken: (name: string) => boolean) {
  const clean = base.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 36) || "theme"
  if (!taken(clean)) return clean
  const free = Array.from({ length: 98 }, (_, index) => `${clean} ${index + 2}`).find((name) => !taken(name))
  return free ?? clean
}
