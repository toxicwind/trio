import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { searchRoutes } from "../src/audit.ts"

// Route-channel contract: ONLY genuine dispatch predicates are routes.
// No default/fallback branch may classify arbitrary conditionals as routes.

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trio-route-"))
  writeFileSync(
    join(dir, "router.ts"),
    [
      `export function handle(mode: string, state: any) {`,
      `  if (mode == "playback.media") return play(state)`,
      `  case "chat/completions": return chat(state)`,
      `  match action { "file_list" => list(state), _ => unknown(state) }`,
      `  const route = "/api/status"`,
      `}`,
    ].join("\n"),
  )
  writeFileSync(
    join(dir, "noise.py"),
    [
      `def tick():`,
      `    if restart_needed:  # guard clause, not a route`,
      `        return`,
      `    if mode_count > 5:  # unrelated conditional`,
      `        cleanup()`,
      `    elif cached_mode:  # declaration-ish noise`,
      `        pass`,
    ].join("\n"),
  )
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("searchRoutes", () => {
  test("dispatch predicates are routes", async () => {
    const hits = await searchRoutes(dir, "playback.media")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.find((h) => h.snippet.includes('mode == "playback.media"'))).toBeTruthy()
  })

  test("case/match/route declarations are routes", async () => {
    const hits = await searchRoutes(dir, "chat/completions")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.find((h) => h.snippet.includes('case "chat/completions"'))).toBeTruthy()
  })

  test("guard clauses and unrelated conditionals are NOT routes", async () => {
    const hits = await searchRoutes(dir, "mode")
    // every hit must be a genuine dispatch predicate, never a guard clause
    for (const h of hits) {
      expect(h.snippet).toMatch(/mode\s*(?:==|!=|in|not in)\s*['"]/)
    }
  })

  test("prefix needle matches dotted mode keys", async () => {
    const hits = await searchRoutes(dir, "playback.media")
    expect(hits.map((h) => h.snippet).join("\n")).toContain("playback.")

  })

  test("empty needle yields no hits", async () => {
    const hits = await searchRoutes(dir, "   ")
    expect(hits).toEqual([])
  })
})