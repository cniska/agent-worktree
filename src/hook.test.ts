import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseHookEvent } from "./hook";
import { type Fixture, fixture, hookEvent, refusal, removeScratchDirs } from "./repo.test-support";

let f: Fixture;

beforeAll(() => {
  f = fixture();
});

afterAll(removeScratchDirs);

describe("parseHookEvent", () => {
  test("reads the name from WorktreeCreate", () => {
    expect(
      parseHookEvent(f.project, hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" })),
    ).toEqual({
      event: "WorktreeCreate",
      name: f.name("task-a"),
    });
  });

  test("refuses a nested WorktreeCreate name as not a worktree name", () => {
    const refused = refusal(() =>
      parseHookEvent(f.project, hookEvent({ hook_event_name: "WorktreeCreate", name: "user/task" })),
    );
    expect(refused.code).toBe("invalid_name");
    expect(refused.message).toBe("user/task is not a worktree name");
  });

  test("reads the name from a WorktreeRemove path at the conventional location", () => {
    expect(
      parseHookEvent(
        f.project,
        hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: f.path("task-a") }),
      ),
    ).toEqual({ event: "WorktreeRemove", name: f.name("task-a") });
  });

  test("reads the name from a WorktreeRemove path in the earlier location inside the primary", () => {
    expect(
      parseHookEvent(
        f.project,
        hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: `${f.dir}/.claude/worktrees/task-a` }),
      ),
    ).toEqual({ event: "WorktreeRemove", name: f.name("task-a") });
  });

  test("refuses a WorktreeRemove path that is not the name's conventional one", () => {
    const foreign = `${f.dir}/elsewhere/task-a`;
    const refused = refusal(() =>
      parseHookEvent(f.project, hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: foreign })),
    );
    expect(refused.code).toBe("foreign_path");
    expect(refused.message).toBe(`${foreign} is not a worktree agent-worktree manages`);
  });

  test("refuses any other event", () => {
    const refused = refusal(() => parseHookEvent(f.project, hookEvent({ hook_event_name: "SessionStart" })));
    expect(refused.code).toBe("hook_event");
    expect(refused.message).toBe("SessionStart is not an event agent-worktree handles");
  });

  test("refuses stdin that is not an event", () => {
    expect(refusal(() => parseHookEvent(f.project, "not json")).code).toBe("hook_input");
    expect(refusal(() => parseHookEvent(f.project, "[]")).message).toBe(
      "stdin is not a Claude Code hook event: the top level is not an object",
    );
    expect(
      refusal(() => parseHookEvent(f.project, hookEvent({ hook_event_name: "WorktreeCreate" }))).message,
    ).toBe("stdin is not a Claude Code hook event: name is not a string");
  });
});
