import { BUG, faulter, messageOf, systemErrorCode } from "./coded-error";

export type Unit = number & { readonly __brand: "Unit" };

export type Block = readonly [Unit, ...Unit[]] & { readonly __brand: "Block" };

export type PortRequest = { readonly ports: number; readonly unitCount: number };

const UNIT_WIDTH = 10;

const FIRST_UNIT = 24000;

const UNIT_COUNT = 100;

const MAX_PORTS = UNIT_COUNT * UNIT_WIDTH;

export const PORT_LIMIT = `from 1 to ${MAX_PORTS}`;

const PORT_COUNT = /^[1-9]\d*\n?$/;

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

function isUnit(port: number): port is Unit {
  return (
    Number.isSafeInteger(port) &&
    port >= FIRST_UNIT &&
    port < FIRST_UNIT + MAX_PORTS &&
    (port - FIRST_UNIT) % UNIT_WIDTH === 0
  );
}

export function parseUnit(text: string): Unit | null {
  if (!DIGITS.test(text)) return null;
  const port = Number(text);
  return isUnit(port) ? port : null;
}

export function units(): readonly Unit[] {
  return Array.from({ length: UNIT_COUNT }, (_, index) => FIRST_UNIT + index * UNIT_WIDTH).filter(isUnit);
}

export function parsePortRequest(text: string): PortRequest | null {
  if (!PORT_COUNT.test(text)) return null;
  const ports = Number(text.trim());
  if (!Number.isSafeInteger(ports) || ports > MAX_PORTS) return null;
  return { ports, unitCount: Math.ceil(ports / UNIT_WIDTH) };
}

function isBlock(units: readonly Unit[]): units is Block {
  return units.length > 0 && units.slice(1).every((unit, index) => unit > (units[index] ?? unit));
}

export function blockOfUnits(held: readonly Unit[]): Block | null {
  const sorted = [...held].sort((a, b) => a - b);
  return isBlock(sorted) ? sorted : null;
}

export function isRunOf(block: Block, unitCount: number): boolean {
  return block.length === unitCount && block.every((unit, index) => unit === block[0] + index * UNIT_WIDTH);
}

export const RANGE = `${FIRST_UNIT} to ${FIRST_UNIT + MAX_PORTS - 1}`;

function runText(first: Unit, last: Unit): string {
  return `${first}-${last + UNIT_WIDTH - 1}`;
}

export function blockText(block: Block): string {
  const runs: string[] = [];
  let first = block[0];
  let last = block[0];
  for (const unit of block.slice(1)) {
    if (unit !== last + UNIT_WIDTH) {
      runs.push(runText(first, last));
      first = unit;
    }
    last = unit;
  }
  return [...runs, runText(first, last)].join(",");
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

export async function isInUse(unit: Unit): Promise<boolean> {
  const ports = Array.from({ length: UNIT_WIDTH }, (_, offset) => unit + offset);
  const probes = ports.flatMap((port) => PROBED_HOSTS.map((host) => listenedOn(host, port)));
  return (await Promise.all(probes)).some((listened) => listened);
}
