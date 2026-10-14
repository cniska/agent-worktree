import { BUG, faulter, messageOf, systemErrorCode } from "./coded-error";

export type Block = number & { readonly __brand: "Block" };

const BLOCK_WIDTH = 10;

const FIRST_BLOCK = 24000;

const BLOCK_COUNT = 100;

const PROBED_HOSTS = ["127.0.0.1", "::1"] as const;

const NO_LISTENER = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"]);

const DIGITS = /^[1-9]\d*$/;

const fault = faulter<{
  readonly port_probe_failed: { readonly host: string; readonly port: number; readonly detail: string };
}>({
  port_probe_failed: {
    message: ({ host, port, detail }) =>
      `connecting to ${host} port ${port} to see whether it is in use failed: ${detail}`,
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

async function listenedOn(hostname: string, port: number): Promise<boolean> {
  try {
    (await Bun.connect({ hostname, port, socket: { data() {} } })).terminate();
    return true;
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== null && NO_LISTENER.has(code)) return false;
    throw fault("port_probe_failed", { host: hostname, port, detail: messageOf(error) });
  }
}

export async function isInUse(block: Block): Promise<boolean> {
  const ports = Array.from({ length: BLOCK_WIDTH }, (_, offset) => block + offset);
  const probes = ports.flatMap((port) => PROBED_HOSTS.map((host) => listenedOn(host, port)));
  return (await Promise.all(probes)).some((listened) => listened);
}
