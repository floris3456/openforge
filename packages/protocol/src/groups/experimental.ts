import { ArtifactEndpoints } from "./artifact.js"
import { AttentionEndpoints } from "./attention.js"
import { AutoUpdateEndpoints } from "./auto-update.js"
import { BlobGetEndpoint } from "./blob.js"
import { AutomationEndpoints } from "./automation.js"
import { JobEndpoints } from "./job.js"
import { MediaGetEndpoint } from "./media.js"
import { PacerEndpoints } from "./pacer.js"
import { PacerNoticeEndpoints } from "./pacer-notices.js"
import { PersistentPtyGroup } from "./persistent-pty.js"
import { ServiceEndpoints } from "./service.js"

/** `server.experimental`: routes under /api/experimental, without compatibility guarantees. */
export const ExperimentalGroup = PersistentPtyGroup.add(
  MediaGetEndpoint,
  BlobGetEndpoint,
  ...AutomationEndpoints,
  ...ArtifactEndpoints,
  ...JobEndpoints,
  ...ServiceEndpoints,
  ...AttentionEndpoints,
  ...PacerEndpoints,
  ...PacerNoticeEndpoints,
  ...AutoUpdateEndpoints,
)
