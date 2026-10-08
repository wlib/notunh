import { test, expect, vi, afterEach } from "vitest"
import { emptyLearned, emptyStats } from "../../src/laundry/model.mts"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock("../../scripts/worker.mts")
  vi.doUnmock("../../scripts/files.mts")
  vi.doUnmock("node:fs/promises")
})

test.each(["failed", "empty"])("a %s inventory preserves the stored model and the previous bundle", async failure => {
  vi.stubEnv("BUILD_TOKEN", "test")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-07T16:00:00Z"))
  const stored = { ...emptyLearned(), through: "2026-10-05", stats: { r: { washer: emptyStats() } } }
  const writeModel = vi.fn()
  const writeFile = vi.fn()
  const readRows = vi.fn(async () => {
    if (failure === "failed")
      throw new Error("Temporary 503")
    return []
  })
  vi.doMock("../../scripts/worker.mts", () => ({ readRows, readModel: async () => stored, writeModel, health: vi.fn() }))
  vi.doMock("../../scripts/files.mts", () => ({ isKept: async () => false, exists: async () => true }))
  vi.doMock("node:fs/promises", () => ({ writeFile }))
  await import("../../scripts/laundry/model.mts")
  expect(readRows).toHaveBeenCalledExactlyOnceWith("machines")
  expect(writeModel).not.toHaveBeenCalled()
  expect(writeFile).not.toHaveBeenCalled()
  expect(stored.through).toBe("2026-10-05")
  expect(stored.stats.r).toBeDefined()
})
