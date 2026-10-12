import { messageOf, refuser } from "./coded-error";
import { nameAt, type Project, parseName, type WorktreeName } from "./project";

type HookEvent = { readonly event: "WorktreeCreate" | "WorktreeRemove"; readonly name: WorktreeName };

const refuse = refuser<{
  readonly hook_input: { readonly detail: string };
  readonly hook_event: { readonly event: string };
  readonly foreign_path: { readonly path: string };
}>({
  hook_input: {
    message: ({ detail }) => `stdin is not a Claude Code hook event: ${detail}`,
    resolve: () =>
      "run agent-worktrees hook only as a Claude Code hook, which writes the event JSON to its stdin",
  },
  hook_event: {
    message: ({ event }) => `${event} is not an event agent-worktrees handles`,
    resolve: () => "configure agent-worktrees hook under WorktreeCreate and WorktreeRemove only",
  },
  foreign_path: {
    message: ({ path }) => `${path} is not a worktree agent-worktrees manages`,
    resolve: () => "remove that worktree with the tool that created it",
  },
});

type HookInput = { readonly [key: string]: unknown };

function isHookInput(value: unknown): value is HookInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookInput(text: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw refuse("hook_input", { detail: messageOf(error) });
  }
  if (!isHookInput(parsed)) throw refuse("hook_input", { detail: "the top level is not an object" });
  return parsed;
}

function field(input: HookInput, name: string): string {
  const value = input[name];
  if (typeof value !== "string") throw refuse("hook_input", { detail: `${name} is not a string` });
  return value;
}

export function parseHookEvent(project: Project, text: string): HookEvent {
  const input = hookInput(text);
  const event = field(input, "hook_event_name");
  if (event === "WorktreeCreate") return { event, name: parseName(project, field(input, "name")) };
  if (event === "WorktreeRemove") {
    const path = field(input, "worktree_path");
    const name = nameAt(project, path);
    if (name === null) throw refuse("foreign_path", { path });
    return { event, name };
  }
  throw refuse("hook_event", { event });
}
