import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Context, Duration, Effect, Layer, LayerMap } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import type { FileSystem } from "@opencode/core/filesystem"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { KV } from "@opencode/core/kv"
import { PacerHeaders } from "@opencode/core/pacer/headers"
import { PacerProject } from "@opencode/core/pacer/project"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Node, makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { initRepo } from "../fixture/git"
import { tempGlobalLayer } from "../fixture/global"
import { gitVcs, location } from "../fixture/location"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"

// A chat's project as CLIProxyPacer is told it (`PacerProject.session`), when the chat is a helper: one whose own
// folder gives it no project takes its lead's, named with the lead's folder; one with a project of its own keeps it
// (workspace task 0v61fkfkn7sh). Each chat's folder is its own location, as openforge places them, laid out as
// theorysnap's are: a workspace outside git holding the repository, and a worktree of a fork with a project of its own.

const workspace = "/virtual/theorysnap"
const repo = "/virtual/theorysnap/theorysnap"
const fork = "/virtual/theorysnap/worktrees/fix/theorysnap-fork"
const elsewhere = "/virtual/notes"
/** The git checkouts, by folder, and their remotes. */
const remotes: Readonly<Record<string, string>> = {
  [repo]: "github.com/acme/theorysnap",
  [fork]: "github.com/acme/theorysnap-fork",
}
const ids = {
  workspace: "theorysnap-workspace",
  repo: "theorysnap-repo",
  fork: "theorysnap-fork",
  elsewhere: "notes",
}

/** The sessions a location's PacerProject read, in order, beyond the test's own reads. */
const reads: Session.ID[] = []

const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const counted = SessionStore.Service.of({
        ...store,
        get: (sessionID) => Effect.suspend(() => (reads.push(sessionID), store.get(sessionID))),
      })
      const map: Context.Service.Shape<typeof LocationServiceMap.Service> = yield* LayerMap.make(
        (ref: Location.Ref) =>
          LayerNode.compile(PacerProject.node, {
            shared: Node.tags.values.global,
            replacements: [
              Location.node.replace(
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      ref,
                      remotes[ref.directory] === undefined
                        ? {}
                        : { vcs: gitVcs(ref.directory), remote: remotes[ref.directory] },
                    ),
                  ),
                ),
              ),
              Config.node.replace(Config.testLayer()),
              Bus.node.replace(Layer.succeed(Bus.Service, bus)),
              SessionStore.node.replace(Layer.succeed(SessionStore.Service, counted)),
              Instance.node.replace(
                Layer.succeed(
                  Instance.Service,
                  Instance.Service.of({ provide: (session) => Effect.provide(map.get(session.location)) }),
                ),
              ),
            ],
          }) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
        // As the service keeps them: a location's services stay once booted.
        { idleTimeToLive: Duration.infinity },
      )
      return map
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Instance.node]),
    [LocationServiceMap.node.replace(locations)],
  ),
)

/** Project `projectID` of `directory`, as openforge keeps one it resolved. */
const project = (directory: string, projectID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make(projectID), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** A chat of `directory` in project `projectID`, a helper of `parentID` when given. */
const chat = (name: string, directory: string, projectID: string, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const id = Session.ID.make(`ses_${name}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`)
    yield* project(directory, projectID)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make(projectID),
        parent_id: parentID,
        slug: id,
        directory: AbsolutePath.make(directory),
        title: name,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

/** The chat's project, as its own location's PacerProject names it. */
const projectOf = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const session = yield* store.get(sessionID)
    if (session === undefined) return yield* Effect.die(new Error(`no session ${sessionID}`))
    return yield* instances.provide(session)(PacerProject.Service.use((projects) => projects.session(session)))
  })

/** `effect`'s answer once `done` holds of it, tried for at most 2 s. */
const settled = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries++) {
      const value = yield* effect
      if (done(value)) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* effect
  })

const named = (project: string, directory: string, name: string) => ({
  project,
  headers: PacerHeaders.project(project, { name, remote: remotes[directory] }),
  repository: directory,
})
const none = { project: undefined, headers: {}, why: PacerProject.OUTSIDE_GIT }

describe("a helper's project", () => {
  it.live("outside git, it is its lead's in git, named as the lead's folder, down the chat tree", () =>
    Effect.gen(function* () {
      const lead = yield* chat("lead", repo, ids.repo)
      const helper = yield* chat("helper", workspace, ids.workspace, lead)
      const nested = yield* chat("nested", elsewhere, ids.elsewhere, helper)

      expect(yield* projectOf(lead)).toEqual(named(ids.repo, repo, "theorysnap"))
      expect(yield* projectOf(helper)).toEqual(named(ids.repo, repo, "theorysnap"))
      expect(yield* projectOf(nested)).toEqual(named(ids.repo, repo, "theorysnap"))
    }),
  )

  it.live("in a git checkout of its own, it keeps that project; its own helpers outside git take it", () =>
    Effect.gen(function* () {
      const lead = yield* chat("lead", repo, ids.repo)
      const helper = yield* chat("helper", fork, ids.fork, lead)
      const nested = yield* chat("nested", workspace, ids.workspace, helper)

      expect(yield* projectOf(helper)).toEqual(named(ids.fork, fork, "theorysnap-fork"))
      // The nearest chat up its tree with a project, not the lead's.
      expect(yield* projectOf(nested)).toEqual(named(ids.fork, fork, "theorysnap-fork"))
    }),
  )

  it.live("of a lead outside git, it is none, with the same words as the lead's", () =>
    Effect.gen(function* () {
      const lead = yield* chat("lead", workspace, ids.workspace)
      const helper = yield* chat("helper", elsewhere, ids.elsewhere, lead)

      expect(yield* projectOf(lead)).toEqual(none)
      expect(yield* projectOf(helper)).toEqual(none)
    }),
  )

  it.live("follows its lead moved into git after the helper was made and had asked", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const lead = yield* chat("lead", workspace, ids.workspace)
      const helper = yield* chat("helper", workspace, ids.workspace, lead)
      expect(yield* projectOf(helper)).toEqual(none)

      // What `SessionMove` publishes once the move is applied: the lead's new folder and its project there.
      yield* project(repo, ids.repo)
      yield* bus.publish(SessionEvent.Moved, {
        sessionID: lead,
        location: Location.Ref.make({ directory: AbsolutePath.make(repo) }),
        projectID: Project.ID.make(ids.repo),
      })

      expect(yield* projectOf(lead)).toEqual(named(ids.repo, repo, "theorysnap"))
      expect(yield* settled(projectOf(helper), (found) => found.project !== undefined)).toEqual(
        named(ids.repo, repo, "theorysnap"),
      )
    }),
  )

  it.live("reads its chat tree once: later requests read no session", () =>
    Effect.gen(function* () {
      const lead = yield* chat("lead", repo, ids.repo)
      const helper = yield* chat("helper", workspace, ids.workspace, lead)
      const outsideLead = yield* chat("outside", elsewhere, ids.elsewhere)
      const outsideHelper = yield* chat("outside-helper", workspace, ids.workspace, outsideLead)
      reads.length = 0

      yield* projectOf(helper)
      yield* projectOf(outsideHelper)
      expect(reads).toEqual([lead, outsideLead])
      yield* projectOf(helper)
      yield* projectOf(outsideHelper)
      expect(reads).toEqual([lead, outsideLead])
    }),
  )
})

// The service's own Location graphs (`LocationServiceMap`, `Instance.layer`), whose global nodes no root builds: the
// first Location to boot builds them, with that Location ambient (as cold-tools found of PacerTools, 2026-11-19).
const disk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "helper-project-")))
const onDisk = {
  elsewhere: path.join(disk, "notes"),
  workspace: path.join(disk, "theorysnap"),
  repo: path.join(disk, "theorysnap", "theorysnap"),
}
for (const folder of Object.values(onDisk)) fs.mkdirSync(folder, { recursive: true })
await initRepo(onDisk.repo)
afterAll(() => fs.rmSync(disk, { recursive: true, force: true }))

const itGraphs = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      KV.node,
      SessionProjector.node,
      SessionStore.node,
      Project.node,
      LocationServiceMap.node,
    ]),
    [Global.node.replace(tempGlobalLayer), offlineModels],
  ),
)

describe("a helper's project in the service's Location graphs", () => {
  itGraphs.live("follows its lead's move published in the lead's Location, when another Location booted first", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const projects = yield* Project.Service
      const locations = yield* LocationServiceMap.Service
      const at = (folder: string) => Location.Ref.make({ directory: AbsolutePath.make(folder) })
      const resolved = yield* projects.resolve(AbsolutePath.make(onDisk.repo))
      const other = yield* chat("other", onDisk.elsewhere, ids.elsewhere)
      const lead = yield* chat("lead", onDisk.workspace, ids.workspace)
      const helper = yield* chat("helper", onDisk.workspace, ids.workspace, lead)
      const projectIn = (sessionID: Session.ID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session === undefined) return yield* Effect.die(new Error(`no session ${sessionID}`))
          return yield* PacerProject.Service.use((found) => found.session(session)).pipe(
            Effect.provide(locations.get(session.location)),
          )
        })

      // A chat elsewhere runs first: its Location boots before the lead's and the helper's.
      expect(yield* projectIn(other)).toEqual(none)
      expect(yield* projectIn(helper)).toEqual(none)
      // Applied by the lead's drain, in its Location.
      yield* bus
        .publish(SessionEvent.Moved, { sessionID: lead, location: at(onDisk.repo), projectID: resolved.id })
        .pipe(Effect.provide(locations.get(at(onDisk.workspace))))

      expect(yield* projectIn(lead)).toEqual({
        project: resolved.id,
        headers: PacerHeaders.project(resolved.id, { name: "theorysnap" }),
        repository: resolved.directory,
      })
      expect(yield* settled(projectIn(helper), (found) => found.project !== undefined)).toEqual({
        project: resolved.id,
        headers: PacerHeaders.project(resolved.id, { name: "theorysnap" }),
        repository: resolved.directory,
      })
    }),
  )
})
