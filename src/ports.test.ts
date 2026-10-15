import { describe, expect, test } from "bun:test";
import { blockOfUnits, blockText, isInUse, isRunOf, parsePortRequest, parseUnit, units } from "./ports";
import { firstFreeUnit } from "./repo.test-support";

describe("units", () => {
  test("are a hundred units of ten from 24000", () => {
    const all = units();
    expect(all).toHaveLength(100);
    const texts = all
      .map((first) => blockOfUnits([first]))
      .map((block) => (block === null ? null : blockText(block)));
    expect([texts[0], texts[1], texts[99]]).toEqual(["24000-24009", "24010-24019", "24990-24999"]);
    expect(all.map((unit) => parseUnit(String(unit)))).toEqual([...all]);
  });

  test.each(["23990", "25000", "24005", "024000", "24000.0", " 24000", ""])("%p is not a unit", (text) => {
    expect(parseUnit(text)).toBeNull();
  });
});

describe("port requests", () => {
  test.each([
    ["1\n", 1, 1],
    ["10", 10, 1],
    ["11\n", 11, 2],
    ["20\n", 20, 2],
    ["1000\n", 1000, 100],
  ])("%p asks for %p ports in %p units", (text, ports, unitCount) => {
    expect(parsePortRequest(text)).toEqual({ ports, unitCount });
  });

  test.each(["0\n", "-1\n", "ten\n", "10 20\n", "1001\n", "", "\n10\n", "10\n\n", "9007199254740993\n"])(
    "%p is not a request",
    (text) => {
      expect(parsePortRequest(text)).toBeNull();
    },
  );
});

describe("blocks", () => {
  test("a block is its units, lowest first, and reads as one run", () => {
    const [first, second] = units();
    if (first === undefined || second === undefined) throw new Error("no units");
    const block = blockOfUnits([second, first]);
    if (block === null) throw new Error("no block");
    expect([...block]).toEqual([first, second]);
    expect(blockText(block)).toBe("24000-24019");
    expect(isRunOf(block, 2)).toBe(true);
    expect(isRunOf(block, 1)).toBe(false);
    expect(blockOfUnits([])).toBeNull();
  });

  test("units with a gap read as each run, and are no run", () => {
    const [first, second, , fourth] = units();
    if (first === undefined || second === undefined || fourth === undefined) throw new Error("no units");
    const block = blockOfUnits([fourth, first, second]);
    if (block === null) throw new Error("no block");
    expect(blockText(block)).toBe("24000-24019,24030-24039");
    expect(isRunOf(block, 3)).toBe(false);
  });
});

describe("isInUse", () => {
  test.each(["127.0.0.1", "0.0.0.0", "::1", "::"])(
    "sees a program listening on %s anywhere in the block",
    async (hostname) => {
      const unit = await firstFreeUnit();
      const held = Bun.listen({ hostname, port: unit + 9, socket: { data() {} } });
      try {
        expect(await isInUse(unit)).toBe(true);
      } finally {
        held.stop(true);
      }
      expect(await isInUse(unit)).toBe(false);
    },
  );
});
