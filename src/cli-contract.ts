import type { JsonValue } from "@toon-format/toon";
import { CodedError } from "./coded-error";

type Options = { readonly [option: string]: { readonly type: "boolean" | "string" } };

export type OptionValue = string | boolean | readonly (string | boolean)[] | undefined;

type Values = { readonly [option: string]: OptionValue };

export type Output =
  | { readonly kind: "result"; readonly result: JsonValue }
  | { readonly kind: "verdict"; readonly result: JsonValue; readonly failed: boolean }
  | { readonly kind: "event"; readonly line: string };

export type Command = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly options: Options;
  run(positionals: readonly string[], values: Values): Promise<Output>;
};

export function result(value: JsonValue): Output {
  return { kind: "result", result: value };
}

export const USAGE_CODE = "usage";

export function usageRefusal(detail: string, usage: string) {
  return new CodedError(USAGE_CODE, detail, {}, usage, "refusal");
}
