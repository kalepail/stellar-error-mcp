import { describe, expect, it } from "vitest";
import {
  normalizeXdrBase64,
  parsePositiveInteger,
} from "../src/input.js";

describe("input helpers", () => {
  it("parses only full positive integers", () => {
    expect(parsePositiveInteger("123")).toBe(123);
    expect(parsePositiveInteger(" 123 ")).toBe(123);
    expect(parsePositiveInteger("10.5")).toBeNull();
    expect(parsePositiveInteger("123abc")).toBeNull();
    expect(parsePositiveInteger("0")).toBeNull();
    expect(parsePositiveInteger("-1")).toBeNull();
    expect(parsePositiveInteger("")).toBeNull();
    expect(parsePositiveInteger(null)).toBeNull();
  });

  it("removes embedded ASCII whitespace from XDR input", () => {
    expect(normalizeXdrBase64(" AAAA\nBBBB\tCCCC  ")).toBe("AAAABBBBCCCC");
  });
});
