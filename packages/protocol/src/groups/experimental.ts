import { ArtifactEndpoints } from "./artifact.js"
import { AttentionEndpoints } from "./attention.js"
import { MediaGetEndpoint } from "./media.js"
import { PacerEndpoints } from "./pacer.js"
import { PacerNoticeEndpoints } from "./pacer-notices.js"
import { PersistentPtyGroup } from "./persistent-pty.js"
import { ScheduleEndpoints } from "./schedule.js"
import { ServiceEndpoints } from "./service.js"

/** `server.experimental`: routes under /api/experimental, without compatibility guarantees. */
export const ExperimentalGroup = PersistentPtyGroup.add(
  MediaGetEndpoint,
  ...ScheduleEndpoints,
  ...ArtifactEndpoints,
  ...ServiceEndpoints,
  ...AttentionEndpoints,
  ...PacerEndpoints,
  ...PacerNoticeEndpoints,
)
