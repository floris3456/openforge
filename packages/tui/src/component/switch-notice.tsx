import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { Spinner } from "./spinner"

/**
 * Says that openforge is switching releases and what the switch waits for; the screen stays usable meanwhile. It takes
 * its own lines above the screen's content rather than covering the start of a transcript.
 */
export function SwitchNotice(props: { message: string }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box
      flexShrink={0}
      marginTop={1}
      marginLeft={2}
      maxWidth={Math.min(72, dimensions().width - 6)}
      justifyContent="center"
      alignItems="flex-start"
      border={["left", "right"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.text.feedback.info.base}
    >
      <box
        width="100%"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.background.raised.high}
      >
        <box flexDirection="row" width="100%">
          <box flexShrink={0} marginRight={1}>
            <Spinner color={theme.text.base} />
          </box>
          <text fg={theme.text.base} wrapMode="word" flexGrow={1} flexShrink={1}>
            {props.message}
          </text>
        </box>
      </box>
    </box>
  )
}
