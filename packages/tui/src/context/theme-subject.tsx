import { createComputed } from "solid-js"
import { projectName } from "../util/project"
import { useData } from "./data"
import { useLocation } from "./location"
import { useRoute } from "./route"
import { useThemes, type ThemeSubject } from "./theme"

/**
 * openforge (spec project-themes): tells the theme what the screen shows, in the same update as the route, so the first
 * frame of a switched tab already has its project's theme. In a chat its root chat's project, on the home screen the
 * project of the folder a new chat starts in. While that isn't known yet, or on a plugin's screen, the theme stays.
 */
export function ThemeSubjectSync() {
  const themes = useThemes()
  const route = useRoute()
  const data = useData()
  const location = useLocation()
  const project = (id: string, directory: string) => ({
    id,
    name: projectName(data.project.get(id), directory) ?? id,
  })

  createComputed(() => {
    const subject = current()
    if (subject) themes.show(subject)
  })
  return null

  function current(): ThemeSubject | undefined {
    const shown = route.data
    if (shown.type === "session") {
      const chat = data.session.root(shown.sessionID)
      const session = data.session.get(chat) ?? data.session.get(shown.sessionID)
      if (!session) return
      return { chat, project: project(session.projectID, session.location.directory) }
    }
    if (shown.type !== "home") return
    const info = location.current
    if (!info) return
    return { project: project(info.project.id, info.project.canonical) }
  }
}
