import { describe, expect, it } from "vitest";
import { colorSlot, signed, splitList } from "./domain";

describe("warehouse UI domain helpers", () => {
  it("supports Chinese and ASCII separators in variant lists", () => {
    expect(splitList("黑色, 白色，雾霾蓝")).toEqual(["黑色", "白色", "雾霾蓝"]);
  });

  it("formats positive stock movement with an explicit sign", () => {
    expect(signed(12)).toBe("+12");
    expect(signed(-3)).toBe("-3");
    expect(signed(0)).toBe("0");
  });

  it("keeps color swatch selection stable", () => {
    expect(colorSlot("曜石黑")).toBe(colorSlot("曜石黑"));
    expect(colorSlot("曜石黑")).toBeGreaterThanOrEqual(0);
    expect(colorSlot("曜石黑")).toBeLessThan(4);
  });
});
