import { encode, type JsonObject, type JsonValue } from "@toon-format/toon";
import { BUG, CodedError, type ErrorKind, messageOf } from "./coded-error";

type PrintedError = {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly meta: JsonObject;
  readonly resolve: string;
};

export function writeResult(command: string, result: JsonValue): void {
  process.stdout.write(`${encode({ command, ok: true, result })}\n`);
}

export function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorOf(error: unknown): PrintedError {
  if (error instanceof CodedError)
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      meta: error.meta,
      resolve: error.resolve,
    };
  return { kind: "fault", code: "unexpected", message: messageOf(error), meta: {}, resolve: BUG };
}

export function writeError(command: string, error: unknown): void {
  process.stderr.write(`${encode({ command, ok: false, error: errorOf(error) })}\n`);
}
