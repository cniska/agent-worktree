import { invariant } from "./assert";

export type Exit =
  | { readonly kind: "exited"; readonly status: number }
  | { readonly kind: "killed"; readonly signal: string };

export function exitOf({
  status,
  signal,
}: {
  readonly status: number | null;
  readonly signal: string | null;
}): Exit {
  if (status !== null) return { kind: "exited", status };
  invariant(signal !== null, "a finished process has a status or a signal");
  return { kind: "killed", signal };
}

export function succeeded(exit: Exit): boolean {
  return exit.kind === "exited" && exit.status === 0;
}

export function describeExit(exit: Exit): string {
  return exit.kind === "exited" ? `exited ${exit.status}` : `was killed by ${exit.signal}`;
}
