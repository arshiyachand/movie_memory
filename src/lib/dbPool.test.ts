import { describe, it, expect } from "vitest";
import { poolConfig, DEFAULT_POOL_MAX } from "@/lib/dbPool";

describe("poolConfig", () => {
  it("uses a small explicit default and passes the connection string through", () => {
    const cfg = poolConfig({ DATABASE_URL: "postgresql://x" });

    expect(cfg.connectionString).toBe("postgresql://x");
    expect(cfg.max).toBe(DEFAULT_POOL_MAX);
    expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(cfg.idleTimeoutMillis).toBeGreaterThan(0);
  });

  it("honors DATABASE_POOL_MAX", () => {
    expect(poolConfig({ DATABASE_POOL_MAX: "12" }).max).toBe(12);
  });

  it.each(["", "abc", "0", "-3"])(
    "falls back to the default for an invalid DATABASE_POOL_MAX (%j)",
    (bad) => {
      expect(poolConfig({ DATABASE_POOL_MAX: bad }).max).toBe(
        DEFAULT_POOL_MAX,
      );
    },
  );
});
