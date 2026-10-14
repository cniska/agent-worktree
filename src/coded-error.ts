type ErrorKind = "refusal" | "fault";

export const BUG =
  "stop and hand this error to the owner as a bug in agent-worktree; no command you run resolves it";

export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";
  readonly code: Code;
  readonly meta: Meta;
  readonly resolve: string;
  readonly kind: ErrorKind;

  constructor(code: Code, message: string, meta: Meta, resolve: string, kind: ErrorKind) {
    super(message);
    this.code = code;
    this.meta = meta;
    this.resolve = resolve;
    this.kind = kind;
  }
}

type ErrorTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

function coder(kind: ErrorKind) {
  return <Metas extends Record<string, object>>(table: ErrorTable<Metas>) =>
    <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Code, Metas[Code]> =>
      new CodedError(code, table[code].message(meta), meta, table[code].resolve(meta), kind);
}

export const refuser = coder("refusal");

export const faulter = coder("fault");

export function systemErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
