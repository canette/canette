import { describe, it, expect } from "vitest"
import { lifecycleStatus } from "../../src/services/lifecycle-status"

describe("lifecycleStatus", () => {
  const running = { desired_state: "running", intent_generation: "3", reconciled_generation: "2" }
  const caughtUp = { ...running, reconciled_generation: "3" }

  it.each([
    ["never deployed", { desired_state: "stopped", intent_generation: 0 }, undefined],
    ["no intent row", {}, undefined],
    ["stop not torn down yet", { desired_state: "stopped", intent_generation: 4, reconciled_generation: 3 }, "stopping"],
    ["stopped", { desired_state: "stopped", intent_generation: 4, reconciled_generation: 4 }, "stopped"],
    ["target queued for a build", { ...running, target_status: "pending_build" }, "building"],
    ["target scanning", { ...running, target_status: "scanning" }, "building"],
    ["target rolling out", { ...running, target_status: "deploying" }, "deploying"],
    ["target live", { ...caughtUp, target_status: "live" }, "live"],
    ["target live, re-sync pending", { ...running, target_status: "live" }, "deploying"],
    ["target failed", { ...caughtUp, target_status: "failed", applied_deployment_id: "older" }, "failed"],
    ["target superseded, an older one serves", { ...caughtUp, target_status: "superseded", applied_deployment_id: "older" }, "live"],
    ["target superseded, nothing serves", { ...caughtUp, target_status: "superseded" }, "stopped"],
  ] as const)("%s", (_, columns, want) => {
    expect(lifecycleStatus(columns)).toBe(want)
  })
})
