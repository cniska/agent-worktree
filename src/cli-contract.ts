import { refuser } from "./coded-error";

type Options = { readonly [option: string]: { readonly type: "boolean" | "string" } };

type Values = {
  readonly [option: string]: string | boolean | readonly (string | boolean)[] | undefined;
};

export type Command = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly options: Options;
  run(positionals: readonly string[], values: Values): readonly string[];
};

export const USAGE_CODE = "usage";

const refuse = refuser<{
  readonly [USAGE_CODE]: { readonly detail: string; readonly usage: string };
}>({
  [USAGE_CODE]: { message: ({ detail }) => detail, resolve: ({ usage }) => usage },
});

export function usageRefusal(detail: string, usage: string) {
  return refuse(USAGE_CODE, { detail, usage });
}
