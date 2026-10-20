import { test, expect, vi, afterEach } from "vitest"
import { emptyLearned, emptyStats } from "../../src/laundry/model.mts"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock("../../scripts/worker.mts")
  vi.doUnmock("../../scripts/files.mts")
})

test.each(["failed", "empty"])("a %s inventory fails before anything is learned, stored, or written, so the inputs keep the last model", async failure => {
  vi.stubEnv("BUILD_TOKEN", "test")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-07T16:00:00Z"))
  const stored = { ...emptyLearned(), through: "2026-10-05", stats: { r: { washer: emptyStats() } } }
  const readModel = vi.fn(async () => ({ state: stored, revision: "r" }))
  const writeModel = vi.fn()
  const writeInput = vi.fn()
  const readRows = vi.fn(async () => {
    if (failure === "failed")
      throw new Error("Temporary 503")
    return []
  })
  vi.doMock("../../scripts/worker.mts", () => ({ readRows, readModel, writeModel, health: vi.fn() }))
  vi.doMock("../../scripts/files.mts", () => ({ STAGED: new URL("file:///inputs/"), writeInput }))
  await expect(import("../../scripts/laundry/model.mts")).rejects.toThrow(failure === "failed" ? "503" : "inventory")
  expect(readRows).toHaveBeenCalledExactlyOnceWith("machines")
  expect(readModel).not.toHaveBeenCalled()
  expect(writeModel).not.toHaveBeenCalled()
  expect(writeInput).not.toHaveBeenCalled()
})
