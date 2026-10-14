import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hookEvent,
  ls,
  PLUGIN,
  pluginCommand,
  project,
  refused,
  removeScratch,
  run,
  script,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

test("AC-18 hook creates on WorktreeCreate and force-removes on WorktreeRemove", () => {
  const w = world();
  const p = project(w);
  script(w, p.dir, "worktree-setup.sh", "echo installing dependencies");
  const path = p.path("task-a");
  const created = run(w, p.dir, ["hook"], {
    stdin: hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" }),
  });
  expect(created.stdout).toBe(`${path}\n`);
  expect(succeeded(created)).toEqual([path]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  writeFileSync(join(path, "untracked"), "work\n");
  const removed = run(w, path, ["hook"], {
    stdin: hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: path }),
  });
  expect(succeeded(removed)).toEqual(["branch task-a kept"]);
  expect(existsSync(path)).toBe(false);
  expect(ls(w, p.dir)).toEqual([]);
});

test("AC-19 hook refuses a foreign path, a nested name, another event and stdin that is not JSON", () => {
  const w = world();
  const p = project(w);
  const hook = (stdin: string) => refused(run(w, p.dir, ["hook"], { stdin }), "hook");
  expect(hook(hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: "/elsewhere/task-a" }))).toEqual({
    message: "/elsewhere/task-a is not a worktree agent-worktree manages",
    act: "remove that worktree with the tool that created it",
  });
  expect(hook(hookEvent({ hook_event_name: "WorktreeCreate", name: "nested/task-a" }))).toEqual({
    message: "nested/task-a is not a worktree name",
    act: "name the worktree with one path segment of letters, digits, dots, underscores and dashes that git accepts as a branch name, and run the command again",
  });
  expect(hook(hookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" }))).toEqual({
    message: "PreToolUse is not an event agent-worktree handles",
    act: "configure agent-worktree hook under WorktreeCreate and WorktreeRemove only",
  });
  const notAnEvent =
    "run agent-worktree hook only as a Claude Code hook, which writes the event JSON to its stdin";
  const notJson = hook("not json");
  expect(notJson.message).toStartWith("stdin is not a Claude Code hook event: ");
  expect(notJson.act).toBe(notAnEvent);
  expect(hook("[]")).toEqual({
    message: "stdin is not a Claude Code hook event: the top level is not an object",
    act: notAnEvent,
  });
  expect(hook(hookEvent({ hook_event_name: "WorktreeCreate" }))).toEqual({
    message: "stdin is not a Claude Code hook event: name is not a string",
    act: notAnEvent,
  });
  expect(ls(w, p.dir)).toEqual([]);
});

type Handler = { readonly matcher: string | null; readonly commands: readonly string[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function handlerOf(value: unknown): Handler {
  if (!isRecord(value) || !Array.isArray(value.hooks)) throw new Error("a handler holds a hooks array");
  const matcher = value.matcher ?? null;
  if (matcher !== null && typeof matcher !== "string") throw new Error("a matcher is a string");
  const commands = value.hooks.map((hook: unknown) => {
    if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string")
      throw new Error("a hook is a command");
    return hook.command;
  });
  return { matcher, commands };
}

function handlers(event: string): readonly Handler[] {
  const parsed: unknown = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) throw new Error("hooks.json holds a hooks object");
  const listed = parsed.hooks[event];
  if (!Array.isArray(listed)) throw new Error(`hooks.json has no ${event} handlers`);
  return listed.map(handlerOf);
}

function commandOf(event: string): string {
  const all = handlers(event).flatMap(({ commands }) => commands);
  expect(all).toHaveLength(1);
  return all[0] ?? "";
}

test("AC-20 the plugin runs hook for both events and the note on the four session sources", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  const created = pluginCommand(
    w,
    p.dir,
    commandOf("WorktreeCreate"),
    hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" }),
  );
  expect(succeeded(created)).toEqual([path]);
  const removed = pluginCommand(
    w,
    path,
    commandOf("WorktreeRemove"),
    hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: path }),
  );
  expect(succeeded(removed)).toEqual(["branch task-a kept"]);
  expect(existsSync(path)).toBe(false);
  const [session] = handlers("SessionStart");
  expect(session?.matcher?.split("|").sort()).toEqual(["clear", "compact", "resume", "startup"]);
  const note = pluginCommand(w, p.dir, commandOf("SessionStart"));
  expect(note).toEqual({
    exitCode: 0,
    stdout: readFileSync(join(PLUGIN, "hooks", "note.md"), "utf8"),
    stderr: "",
  });
  expect(note.stdout).toContain("agent-worktree create <name>");
});
