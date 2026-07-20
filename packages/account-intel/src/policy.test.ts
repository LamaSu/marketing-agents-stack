import { describe, it, expect } from "vitest";
import { isAutopilotEligible } from "./policy.js";

describe("isAutopilotEligible", () => {
  it("is eligible for autopilot + PARTIAL_FIT", () => {
    expect(isAutopilotEligible("PARTIAL_FIT", "autopilot")).toBe(true);
  });

  it("is never eligible for STRONG_FIT, regardless of mode -- the named VIP exclusion", () => {
    expect(isAutopilotEligible("STRONG_FIT", "autopilot")).toBe(false);
  });

  it("is never eligible for FIT (excluded conservatively -- not 'low-tier')", () => {
    expect(isAutopilotEligible("FIT", "autopilot")).toBe(false);
  });

  it("is never eligible for DISQUALIFIED", () => {
    expect(isAutopilotEligible("DISQUALIFIED", "autopilot")).toBe(false);
  });

  it("is never eligible in copilot mode, regardless of tier", () => {
    expect(isAutopilotEligible("PARTIAL_FIT", "copilot")).toBe(false);
    expect(isAutopilotEligible("STRONG_FIT", "copilot")).toBe(false);
  });
});
