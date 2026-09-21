import { describe, it, expect } from "vitest";
import { errorFields } from "@/lib/logger";

describe("errorFields", () => {
  it("extracts a numeric status and the message", () => {
    const err = Object.assign(new Error("Rate limit reached"), { status: 429 });
    expect(errorFields(err)).toEqual({ errorStatus: 429, errorMessage: "Rate limit reached" });
  });

  it("omits status when the error has none (e.g. a plain Error)", () => {
    expect(errorFields(new Error("boom"))).toEqual({ errorMessage: "boom" });
  });

  it("scrubs API keys and bearer tokens out of messages", () => {
    const { errorMessage } = errorFields(
      new Error("Incorrect API key provided: sk-proj-AbC123***xyz. Authorization: Bearer abc.def.ghi"),
    );
    expect(errorMessage).not.toMatch(/sk-proj/);
    expect(errorMessage).not.toMatch(/abc\.def\.ghi/);
    expect(errorMessage).toContain("sk-[redacted]");
    expect(errorMessage).toContain("Bearer [redacted]");
  });

  it("caps very long messages", () => {
    expect(errorFields(new Error("x".repeat(5000))).errorMessage).toHaveLength(300);
  });

  it("handles non-Error throwables", () => {
    expect(errorFields("just a string")).toEqual({ errorMessage: "just a string" });
  });
});
