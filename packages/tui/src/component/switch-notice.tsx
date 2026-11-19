import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { stringWidth } from "../util/string-width"
import { Locale } from "../util/locale"

/**
 * Says that openforge is switching releases, on one row beside the prompt rather than above the transcript.
 * `message` counts what the switch waits for and names no chat; `compact` drops that count when the row is narrow, and
 * a row still too narrow is cut rather than wrapped.
 */
export function SwitchNotice(props: { message: string; compact: string }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  // The row's right margin, its spinner and the gap after it.
  const room = () => Math.max(0, dimensions().width - 4)
  const line = () => {
    if (stringWidth(props.message) <= room()) return props.message
    if (stringWidth(props.compact) <= room()) return props.compact
    return Locale.truncateWidth(props.compact, room())
  }
  return (
    <box flexShrink={0} height={1} flexDirection="row" justifyContent="flex-end" paddingRight={2} gap={1}>
      <Spinner color={theme.text.feedback.info.base} />
      <text fg={theme.text.base} wrapMode="none">
        {line()}
      </text>
    </box>
  )
}
