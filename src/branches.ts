import type { JsonObject } from "@toon-format/toon";
import { unreachable } from "./assert";
import {
  branchRef,
  branchTip,
  commitOf,
  deleteBranchAt,
  deleteRef,
  deleteRemoteBranch,
  fetchBranch,
  hasRemote,
  isAncestor,
  isSquashLanded,
  type Reached,
  type RemoteBranch,
  remoteRefs,
  trackingRef,
  type Upstream,
  upstreamOf,
  worktrees,
} from "./git";

type Landing = "merged" | "squash-merged";

export type BranchFate =
  | { readonly kind: "detached" }
  | {
      readonly kind: "deleted";
      readonly branch: string;
      readonly landing: Landing;
      readonly into: string;
      readonly remoteBranch: string | null;
    }
  | { readonly kind: "unmerged"; readonly branch: string; readonly into: string }
  | { readonly kind: "no_remote"; readonly branch: string; readonly remote: string }
  | {
      readonly kind: "remote_unreachable";
      readonly branch: string;
      readonly remote: string;
      readonly detail: string;
    }
  | { readonly kind: "no_default_branch"; readonly branch: string; readonly remote: string }
  | { readonly kind: "tracks_default"; readonly branch: string; readonly into: string }
  | { readonly kind: "remote_branch_ahead"; readonly branch: string; readonly remoteBranch: string }
  | {
      readonly kind: "remote_branch_kept";
      readonly branch: string;
      readonly remoteBranch: string;
      readonly detail: string;
    }
  | { readonly kind: "checked_out"; readonly branch: string; readonly at: string };

type RemoteView =
  | { readonly kind: "absent" }
  | { readonly kind: "remote_unreachable"; readonly detail: string }
  | { readonly kind: "no_default_branch" }
  | {
      readonly kind: "reached";
      readonly defaultRef: string;
      readonly into: string;
      readonly heads: ReadonlyMap<string, string>;
    };

export type Remotes = {
  readonly view: (remote: string) => RemoteView;
  readonly deleteBranch: (target: RemoteBranch) => Reached<null>;
};

const DEFAULT_REMOTE = "origin";

const NETWORK_TIMEOUT_MS = 60_000;

function viewOf(repo: string, remote: string, timeoutMs: number): RemoteView {
  if (!hasRemote(repo, remote)) return { kind: "absent" };
  const refs = remoteRefs(repo, remote, timeoutMs);
  if (refs.kind === "failed") return { kind: "remote_unreachable", detail: refs.detail };
  const { defaultRef, heads } = refs.value;
  if (defaultRef === null) return { kind: "no_default_branch" };
  const fetched = fetchBranch(repo, remote, defaultRef, timeoutMs);
  if (fetched.kind === "failed") return { kind: "remote_unreachable", detail: fetched.detail };
  return { kind: "reached", defaultRef, into: fetched.value, heads };
}

export function remotesOf(repo: string, timeoutMs = NETWORK_TIMEOUT_MS): Remotes {
  const seen = new Map<string, RemoteView>();
  const view = (remote: string): RemoteView => {
    const known = seen.get(remote);
    if (known !== undefined) return known;
    const fresh = viewOf(repo, remote, timeoutMs);
    seen.set(remote, fresh);
    return fresh;
  };
  return { view, deleteBranch: (target) => deleteRemoteBranch(repo, target, timeoutMs) };
}

export type CutBase =
  | { readonly kind: "default"; readonly base: string }
  | { readonly kind: "head"; readonly reason: "no_remote" | "no_default_branch"; readonly remote: string }
  | { readonly kind: "unreachable"; readonly remote: string; readonly detail: string };

export function cutBase(remotes: Remotes): CutBase {
  const remote = DEFAULT_REMOTE;
  const view = remotes.view(remote);
  switch (view.kind) {
    case "absent":
      return { kind: "head", reason: "no_remote", remote };
    case "no_default_branch":
      return { kind: "head", reason: "no_default_branch", remote };
    case "remote_unreachable":
      return { kind: "unreachable", remote, detail: view.detail };
    case "reached":
      return { kind: "default", base: view.into };
    default:
      return unreachable(view);
  }
}

function landingOf(repo: string, tip: string, into: string, upstreamGone: boolean): Landing | null {
  if (isAncestor(repo, tip, into)) return "merged";
  if (upstreamGone && isSquashLanded(repo, tip, into)) return "squash-merged";
  return null;
}

type RemotePlan =
  | { readonly kind: "none" }
  | { readonly kind: "gone"; readonly tracking: string }
  | { readonly kind: "ahead"; readonly tracking: string }
  | {
      readonly kind: "delete";
      readonly tracking: string;
      readonly target: RemoteBranch;
      readonly hasUpstream: boolean;
    };

function remoteBranchPlan(
  repo: string,
  remote: string,
  ref: string,
  remoteTip: string,
  tip: string,
  hasUpstream: boolean,
): RemotePlan {
  const tracking = trackingRef(remote, ref);
  if (commitOf(repo, remoteTip) === null || !isAncestor(repo, remoteTip, tip))
    return { kind: "ahead", tracking };
  return { kind: "delete", tracking, target: { remote, ref, tip: remoteTip }, hasUpstream };
}

function remotePlan(
  repo: string,
  branch: string,
  upstream: Upstream | null,
  remote: string,
  view: Extract<RemoteView, { readonly kind: "reached" }>,
  tip: string,
): RemotePlan {
  if (upstream === null) {
    const ref = branchRef(branch);
    const remoteTip = view.heads.get(ref);
    if (ref === view.defaultRef || remoteTip === undefined) return { kind: "none" };
    return remoteBranchPlan(repo, remote, ref, remoteTip, tip, false);
  }
  const remoteTip = view.heads.get(upstream.ref);
  if (remoteTip === undefined) return { kind: "gone", tracking: trackingRef(remote, upstream.ref) };
  return remoteBranchPlan(repo, remote, upstream.ref, remoteTip, tip, true);
}

type Verdict =
  | { readonly kind: "kept"; readonly fate: BranchFate }
  | {
      readonly kind: "landed";
      readonly branch: string;
      readonly tip: string;
      readonly landing: Landing;
      readonly into: string;
      readonly plan: Exclude<RemotePlan, { readonly kind: "ahead" }>;
    };

function isFromUpstream(plan: Exclude<RemotePlan, { readonly kind: "ahead" }>): boolean {
  switch (plan.kind) {
    case "none":
      return false;
    case "gone":
      return true;
    case "delete":
      return plan.hasUpstream;
    default:
      return unreachable(plan);
  }
}

function kept(fate: BranchFate): Verdict {
  return { kind: "kept", fate };
}

function judge(repo: string, branch: string, remotes: Remotes): Verdict {
  const upstream = upstreamOf(repo, branch);
  const remote = upstream?.remote ?? DEFAULT_REMOTE;
  const view = remotes.view(remote);
  switch (view.kind) {
    case "absent":
      return kept({ kind: "no_remote", branch, remote });
    case "remote_unreachable":
      return kept({ kind: "remote_unreachable", branch, remote, detail: view.detail });
    case "no_default_branch":
      return kept({ kind: "no_default_branch", branch, remote });
    case "reached":
      break;
    default:
      return unreachable(view);
  }
  if (upstream !== null && upstream.ref === view.defaultRef)
    return kept({ kind: "tracks_default", branch, into: view.into });
  const tip = branchTip(repo, branch);
  const plan = remotePlan(repo, branch, upstream, remote, view, tip);
  const landing = landingOf(repo, tip, view.into, plan.kind === "gone");
  if (landing === null) return kept({ kind: "unmerged", branch, into: view.into });
  if (plan.kind === "ahead")
    return kept({ kind: "remote_branch_ahead", branch, remoteBranch: plan.tracking });
  return { kind: "landed", branch, tip, landing, into: view.into, plan };
}

export function hasLandedUpstream(repo: string, branch: string, remotes: Remotes): boolean {
  const verdict = judge(repo, branch, remotes);
  return verdict.kind === "landed" && isFromUpstream(verdict.plan);
}

export function settleBranch(repo: string, branch: string | null, remotes: Remotes): BranchFate {
  if (branch === null) return { kind: "detached" };
  const elsewhere = worktrees(repo).find((tree) => tree.branch === branch);
  if (elsewhere !== undefined) return { kind: "checked_out", branch, at: elsewhere.path };
  const verdict = judge(repo, branch, remotes);
  if (verdict.kind === "kept") return verdict.fate;
  const { tip, landing, into, plan } = verdict;
  if (plan.kind === "delete") {
    const deleted = remotes.deleteBranch(plan.target);
    if (deleted.kind === "failed")
      return { kind: "remote_branch_kept", branch, remoteBranch: plan.tracking, detail: deleted.detail };
  }
  deleteBranchAt(repo, branch, tip);
  if (plan.kind === "gone") deleteRef(repo, plan.tracking);
  const remoteBranchDeleted = plan.kind === "delete" ? plan.tracking : null;
  return { kind: "deleted", branch, landing, into, remoteBranch: remoteBranchDeleted };
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, "");
}

export function fateText(fate: BranchFate): string {
  switch (fate.kind) {
    case "detached":
      return "detached";
    case "deleted": {
      const remoteBranch = fate.remoteBranch === null ? "" : `, and ${shortRef(fate.remoteBranch)} deleted`;
      return `branch ${fate.branch} deleted, ${fate.landing} into ${shortRef(fate.into)}${remoteBranch}`;
    }
    case "unmerged":
      return `branch ${fate.branch} kept, not merged into ${shortRef(fate.into)}`;
    case "no_remote":
      return `branch ${fate.branch} kept, no remote ${fate.remote}`;
    case "remote_unreachable":
      return `branch ${fate.branch} kept, ${fate.remote} could not be reached: ${fate.detail}`;
    case "no_default_branch":
      return `branch ${fate.branch} kept, ${fate.remote} has no default branch`;
    case "tracks_default":
      return `branch ${fate.branch} kept, it tracks ${shortRef(fate.into)}`;
    case "remote_branch_ahead":
      return `branch ${fate.branch} kept, ${shortRef(fate.remoteBranch)} has commits it lacks`;
    case "remote_branch_kept":
      return `branch ${fate.branch} kept, deleting ${shortRef(fate.remoteBranch)} failed: ${fate.detail}`;
    case "checked_out":
      return `branch ${fate.branch} kept, checked out at ${fate.at}`;
    default:
      return unreachable(fate);
  }
}

export function fateRecord(fate: BranchFate): JsonObject {
  switch (fate.kind) {
    case "detached":
      return { branch: null, outcome: fate.kind };
    case "deleted":
      return {
        branch: fate.branch,
        outcome: fate.kind,
        landing: fate.landing,
        into: shortRef(fate.into),
        remoteBranch: fate.remoteBranch === null ? null : shortRef(fate.remoteBranch),
      };
    case "unmerged":
    case "tracks_default":
      return { branch: fate.branch, outcome: fate.kind, into: shortRef(fate.into) };
    case "no_remote":
    case "no_default_branch":
      return { branch: fate.branch, outcome: fate.kind, remote: fate.remote };
    case "remote_unreachable":
      return { branch: fate.branch, outcome: fate.kind, remote: fate.remote, detail: fate.detail };
    case "remote_branch_ahead":
      return { branch: fate.branch, outcome: fate.kind, remoteBranch: shortRef(fate.remoteBranch) };
    case "remote_branch_kept":
      return {
        branch: fate.branch,
        outcome: fate.kind,
        remoteBranch: shortRef(fate.remoteBranch),
        detail: fate.detail,
      };
    case "checked_out":
      return { branch: fate.branch, outcome: fate.kind, at: fate.at };
    default:
      return unreachable(fate);
  }
}
