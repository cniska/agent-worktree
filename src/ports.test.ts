import { describe, expect, test } from "bun:test";
import { blocks, blockText, isInUse, parseBlock } from "./ports";
import { firstFreeBlock } from "./repo.test-support";

describe("blocks", () => {
  test("are a hundred blocks of ten from 24000", () => {
    const all = blocks();
    expect(all).toHaveLength(100);
    const texts = all.map(blockText);
    expect([texts[0], texts[1], texts[99]]).toEqual(["24000-24009", "24010-24019", "24990-24999"]);
    expect(all.map((block) => parseBlock(String(block)))).toEqual([...all]);
  });

  test.each(["23990", "25000", "24005", "024000", "24000.0", " 24000", ""])("%p is not a block", (text) => {
    expect(parseBlock(text)).toBeNull();
  });
});

describe("isInUse", () => {
  test.each(["127.0.0.1", "0.0.0.0", "::1", "::"])(
    "sees a program listening on %s anywhere in the block",
    async (hostname) => {
      const block = await firstFreeBlock();
      const held = Bun.listen({ hostname, port: block + 9, socket: { data() {} } });
      try {
        expect(await isInUse(block)).toBe(true);
      } finally {
        held.stop(true);
      }
      expect(await isInUse(block)).toBe(false);
    },
  );
});
