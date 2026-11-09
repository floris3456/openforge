/// <reference path="./audio.d.ts" />
import type { Attention } from "@opencode/schema/attention"
import alert_01 from "@opencode/ui/audio/alert-01.mp3" with { type: "file" }
import alert_02 from "@opencode/ui/audio/alert-02.mp3" with { type: "file" }
import alert_03 from "@opencode/ui/audio/alert-03.mp3" with { type: "file" }
import alert_04 from "@opencode/ui/audio/alert-04.mp3" with { type: "file" }
import alert_05 from "@opencode/ui/audio/alert-05.mp3" with { type: "file" }
import alert_06 from "@opencode/ui/audio/alert-06.mp3" with { type: "file" }
import alert_07 from "@opencode/ui/audio/alert-07.mp3" with { type: "file" }
import alert_08 from "@opencode/ui/audio/alert-08.mp3" with { type: "file" }
import alert_09 from "@opencode/ui/audio/alert-09.mp3" with { type: "file" }
import alert_10 from "@opencode/ui/audio/alert-10.mp3" with { type: "file" }
import bipBop_01 from "@opencode/ui/audio/bip-bop-01.mp3" with { type: "file" }
import bipBop_02 from "@opencode/ui/audio/bip-bop-02.mp3" with { type: "file" }
import bipBop_03 from "@opencode/ui/audio/bip-bop-03.mp3" with { type: "file" }
import bipBop_04 from "@opencode/ui/audio/bip-bop-04.mp3" with { type: "file" }
import bipBop_05 from "@opencode/ui/audio/bip-bop-05.mp3" with { type: "file" }
import bipBop_06 from "@opencode/ui/audio/bip-bop-06.mp3" with { type: "file" }
import bipBop_07 from "@opencode/ui/audio/bip-bop-07.mp3" with { type: "file" }
import bipBop_08 from "@opencode/ui/audio/bip-bop-08.mp3" with { type: "file" }
import bipBop_09 from "@opencode/ui/audio/bip-bop-09.mp3" with { type: "file" }
import bipBop_10 from "@opencode/ui/audio/bip-bop-10.mp3" with { type: "file" }
import nope_01 from "@opencode/ui/audio/nope-01.mp3" with { type: "file" }
import nope_02 from "@opencode/ui/audio/nope-02.mp3" with { type: "file" }
import nope_03 from "@opencode/ui/audio/nope-03.mp3" with { type: "file" }
import nope_04 from "@opencode/ui/audio/nope-04.mp3" with { type: "file" }
import nope_05 from "@opencode/ui/audio/nope-05.mp3" with { type: "file" }
import nope_06 from "@opencode/ui/audio/nope-06.mp3" with { type: "file" }
import nope_07 from "@opencode/ui/audio/nope-07.mp3" with { type: "file" }
import nope_08 from "@opencode/ui/audio/nope-08.mp3" with { type: "file" }
import nope_09 from "@opencode/ui/audio/nope-09.mp3" with { type: "file" }
import nope_10 from "@opencode/ui/audio/nope-10.mp3" with { type: "file" }
import nope_11 from "@opencode/ui/audio/nope-11.mp3" with { type: "file" }
import nope_12 from "@opencode/ui/audio/nope-12.mp3" with { type: "file" }
import staplebops_01 from "@opencode/ui/audio/staplebops-01.mp3" with { type: "file" }
import staplebops_02 from "@opencode/ui/audio/staplebops-02.mp3" with { type: "file" }
import staplebops_03 from "@opencode/ui/audio/staplebops-03.mp3" with { type: "file" }
import staplebops_04 from "@opencode/ui/audio/staplebops-04.mp3" with { type: "file" }
import staplebops_05 from "@opencode/ui/audio/staplebops-05.mp3" with { type: "file" }
import staplebops_06 from "@opencode/ui/audio/staplebops-06.mp3" with { type: "file" }
import staplebops_07 from "@opencode/ui/audio/staplebops-07.mp3" with { type: "file" }
import yup_01 from "@opencode/ui/audio/yup-01.mp3" with { type: "file" }
import yup_02 from "@opencode/ui/audio/yup-02.mp3" with { type: "file" }
import yup_03 from "@opencode/ui/audio/yup-03.mp3" with { type: "file" }
import yup_04 from "@opencode/ui/audio/yup-04.mp3" with { type: "file" }
import yup_05 from "@opencode/ui/audio/yup-05.mp3" with { type: "file" }
import yup_06 from "@opencode/ui/audio/yup-06.mp3" with { type: "file" }

// Every built-in sound, embedded in the build: a sound picked in Settings, or named by a TUI to a player, plays from
// this install.
export const soundFiles: Record<Attention.SoundID, string> = {
  "alert-01": alert_01,
  "alert-02": alert_02,
  "alert-03": alert_03,
  "alert-04": alert_04,
  "alert-05": alert_05,
  "alert-06": alert_06,
  "alert-07": alert_07,
  "alert-08": alert_08,
  "alert-09": alert_09,
  "alert-10": alert_10,
  "bip-bop-01": bipBop_01,
  "bip-bop-02": bipBop_02,
  "bip-bop-03": bipBop_03,
  "bip-bop-04": bipBop_04,
  "bip-bop-05": bipBop_05,
  "bip-bop-06": bipBop_06,
  "bip-bop-07": bipBop_07,
  "bip-bop-08": bipBop_08,
  "bip-bop-09": bipBop_09,
  "bip-bop-10": bipBop_10,
  "nope-01": nope_01,
  "nope-02": nope_02,
  "nope-03": nope_03,
  "nope-04": nope_04,
  "nope-05": nope_05,
  "nope-06": nope_06,
  "nope-07": nope_07,
  "nope-08": nope_08,
  "nope-09": nope_09,
  "nope-10": nope_10,
  "nope-11": nope_11,
  "nope-12": nope_12,
  "staplebops-01": staplebops_01,
  "staplebops-02": staplebops_02,
  "staplebops-03": staplebops_03,
  "staplebops-04": staplebops_04,
  "staplebops-05": staplebops_05,
  "staplebops-06": staplebops_06,
  "staplebops-07": staplebops_07,
  "yup-01": yup_01,
  "yup-02": yup_02,
  "yup-03": yup_03,
  "yup-04": yup_04,
  "yup-05": yup_05,
  "yup-06": yup_06,
}
