import { addBusinessDays, businessDateString, parseBusinessDate, scheduledAtFor } from "./warehouse-time";

describe("warehouse time", () => {
  it("uses the Shanghai business date across the UTC day boundary", () => {
    expect(businessDateString(new Date("2026-07-30T15:59:59.000Z"))).toBe("2026-07-30");
    expect(businessDateString(new Date("2026-07-30T16:00:00.000Z"))).toBe("2026-07-31");
  });

  it("converts an administrator cutoff into an absolute instant", () => {
    expect(scheduledAtFor("2026-07-30", "20:00").toISOString()).toBe("2026-07-30T12:00:00.000Z");
    expect(scheduledAtFor("2026-07-30", "00:15").toISOString()).toBe("2026-07-29T16:15:00.000Z");
  });

  it("adds calendar days without depending on the host timezone", () => {
    expect(addBusinessDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => parseBusinessDate("2026-02-30")).toThrow("业务日期无效");
  });
});
