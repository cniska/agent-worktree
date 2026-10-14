import { describe, expect, test } from "bun:test";
import { blocks, blockText, isBound, parseBlock } from "./ports";

function freeBlock() {
  const free = blocks().find((block) => !isBound(block));
  if (free === undefined) throw new Error("every port block is bound on this machine");
  return free;
}

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

describe("isBound", () => {
  test.each(["127.0.0.1", "0.0.0.0", "::1", "::"])(
    "sees a port held on %s anywhere in the block",
    (hostname) => {
      const block = freeBlock();
      const held = Bun.listen({ hostname, port: block + 9, socket: { data() {} } });
      try {
        expect(isBound(block)).toBe(true);
      } finally {
        held.stop(true);
      }
      expect(isBound(block)).toBe(false);
    },
  );
});
