import assert from "node:assert/strict";
import { describe, it } from "node:test";

type AsyncMatchers = {
  toBe(expected: unknown): Promise<void>;
  toBeNull(): Promise<void>;
  toBeUndefined(): Promise<void>;
  toContain(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toHaveLength(expected: number): Promise<void>;
  toMatchObject(expected: unknown): Promise<void>;
};

type SyncMatchers = {
  readonly not: {
    toBe(expected: unknown): void;
    toContain(expected: unknown): void;
  };
  readonly resolves: AsyncMatchers;
  toBe(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toContain(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toMatchObject(expected: unknown): void;
  toThrow(expected?: string | RegExp): void;
};

function containsValue(container: unknown, expected: unknown): boolean {
  if (typeof container === "string") {
    return typeof expected === "string" && container.includes(expected);
  }

  if (Array.isArray(container)) {
    return container.some((entry) => {
      try {
        assert.deepStrictEqual(
          normalizeForComparison(entry),
          normalizeForComparison(expected),
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  return false;
}

function assertContains(container: unknown, expected: unknown): void {
  assert.equal(
    containsValue(container, expected),
    true,
    `Expected ${String(container)} to contain ${String(expected)}`,
  );
}

function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForComparison(entry));
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => [key, normalizeForComparison(entry)] as const,
    );
    return Object.fromEntries(entries);
  }

  return value;
}

function createAsyncMatchers(promise: Promise<unknown>): AsyncMatchers {
  return {
    async toBe(expected: unknown): Promise<void> {
      assert.equal(await promise, expected);
    },
    async toBeNull(): Promise<void> {
      assert.equal(await promise, null);
    },
    async toBeUndefined(): Promise<void> {
      assert.equal(await promise, undefined);
    },
    async toContain(expected: unknown): Promise<void> {
      assertContains(await promise, expected);
    },
    async toEqual(expected: unknown): Promise<void> {
      assert.deepStrictEqual(
        normalizeForComparison(await promise),
        normalizeForComparison(expected),
      );
    },
    async toHaveLength(expected: number): Promise<void> {
      const resolved = await promise;
      if (
        resolved === null ||
        resolved === undefined ||
        typeof (resolved as { length?: unknown }).length !== "number"
      ) {
        throw new assert.AssertionError({
          message: "Resolved value does not have a numeric length.",
        });
      }
      assert.equal((resolved as { length: number }).length, expected);
    },
    async toMatchObject(expected: unknown): Promise<void> {
      assert.partialDeepStrictEqual(
        normalizeForComparison(await promise),
        normalizeForComparison(expected),
      );
    },
  };
}

export function expect(actual: unknown): SyncMatchers {
  return {
    not: {
      toBe(expected: unknown): void {
        assert.notStrictEqual(actual, expected);
      },
      toContain(expected: unknown): void {
        assert.equal(
          containsValue(actual, expected),
          false,
          `Expected ${String(actual)} not to contain ${String(expected)}`,
        );
      },
    },
    resolves: createAsyncMatchers(Promise.resolve(actual)),
    toBe(expected: unknown): void {
      assert.equal(actual, expected);
    },
    toBeNull(): void {
      assert.equal(actual, null);
    },
    toBeUndefined(): void {
      assert.equal(actual, undefined);
    },
    toContain(expected: unknown): void {
      assertContains(actual, expected);
    },
    toEqual(expected: unknown): void {
      assert.deepStrictEqual(
        normalizeForComparison(actual),
        normalizeForComparison(expected),
      );
    },
    toHaveLength(expected: number): void {
      if (
        actual === null ||
        actual === undefined ||
        typeof (actual as { length?: unknown }).length !== "number"
      ) {
        throw new assert.AssertionError({
          message: "Value does not have a numeric length.",
        });
      }
      assert.equal((actual as { length: number }).length, expected);
    },
    toMatchObject(expected: unknown): void {
      assert.partialDeepStrictEqual(
        normalizeForComparison(actual),
        normalizeForComparison(expected),
      );
    },
    toThrow(expected?: string | RegExp): void {
      assert.equal(typeof actual, "function");
      const fn = actual as () => unknown;
      if (expected === undefined) {
        assert.throws(fn);
        return;
      }

      if (typeof expected === "string") {
        assert.throws(fn, (error: unknown) => {
          return error instanceof Error && error.message.includes(expected);
        });
        return;
      }

      assert.throws(fn, expected);
    },
  };
}

export { describe, it };
