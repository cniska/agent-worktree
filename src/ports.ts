import { BUG, faulter, messageOf } from "./coded-error";

export type Block = number & { readonly __brand: "Block" };

export const BLOCK_WIDTH = 10;

const FIRST_BLOCK = 24000;

const BLOCK_COUNT = 100;

const PROBED_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

const BOUND = "EADDRINUSE";

const HOST_WITHOUT_FAMILY = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

const DIGITS = /^[1-9]\d*$/;

const fault = faulter<{
  readonly port_probe_failed: { readonly host: string; readonly port: number; readonly detail: string };
}>({
  port_probe_failed: {
    message: ({ host, port, detail }) =>
      `listening on ${host} port ${port} to see whether it is free failed: ${detail}`,
    resolve: () => BUG,
  },
});

function isBlock(port: number): port is Block {
  return (
    Number.isSafeInteger(port) &&
    port >= FIRST_BLOCK &&
    port < FIRST_BLOCK + BLOCK_COUNT * BLOCK_WIDTH &&
    (port - FIRST_BLOCK) % BLOCK_WIDTH === 0
  );
}

export function parseBlock(text: string): Block | null {
  if (!DIGITS.test(text)) return null;
  const port = Number(text);
  return isBlock(port) ? port : null;
}

export function blocks(): readonly Block[] {
  return Array.from({ length: BLOCK_COUNT }, (_, index) => FIRST_BLOCK + index * BLOCK_WIDTH).filter(isBlock);
}

export const RANGE = `${FIRST_BLOCK} to ${FIRST_BLOCK + BLOCK_COUNT * BLOCK_WIDTH - 1}`;

export function blockText(block: Block): string {
  return `${block}-${block + BLOCK_WIDTH - 1}`;
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function boundOn(hostname: string, port: number): boolean {
  try {
    Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    return false;
  } catch (error) {
    const code = errorCode(error);
    if (code === BOUND) return true;
    if (code !== null && HOST_WITHOUT_FAMILY.has(code)) return false;
    throw fault("port_probe_failed", { host: hostname, port, detail: messageOf(error) });
  }
}

export function isBound(block: Block): boolean {
  return Array.from({ length: BLOCK_WIDTH }, (_, offset) => block + offset).some((port) =>
    PROBED_HOSTS.some((host) => boundOn(host, port)),
  );
}
