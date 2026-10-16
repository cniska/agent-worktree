import { unreachable } from "./assert";
import {
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
      readonly upstream: string | null;
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
  | { readonly kind: "upstream_ahead"; readonly branch: string; readonly upstream: string }
  | {
      readonly kind: "upstream_kept";
      readonly branch: string;
      readonly upstream: string;
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

type UpstreamPlan =
  | { readonly kind: "none" }
  | { readonly kind: "gone"; readonly tracking: string }
  | { readonly kind: "ahead"; readonly tracking: string }
  | { readonly kind: "delete"; readonly tracking: string; readonly target: RemoteBranch };

function upstreamPlan(
  repo: string,
  upstream: Upstream | null,
  heads: ReadonlyMap<string, string>,
  tip: string,
): UpstreamPlan {
  if (upstream === null) return { kind: "none" };
  const tracking = trackingRef(upstream.remote, upstream.ref);
  const remoteTip = heads.get(upstream.ref);
  if (remoteTip === undefined) return { kind: "gone", tracking };
  if (commitOf(repo, remoteTip) === null || !isAncestor(repo, remoteTip, tip))
    return { kind: "ahead", tracking };
  return { kind: "delete", tracking, target: { remote: upstream.remote, ref: upstream.ref, tip: remoteTip } };
}

type Verdict =
  | { readonly kind: "kept"; readonly fate: BranchFate }
  | {
      readonly kind: "landed";
      readonly branch: string;
      readonly tip: string;
      readonly landing: Landing;
      readonly into: string;
      readonly plan: Exclude<UpstreamPlan, { readonly kind: "ahead" }>;
    };

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
  const plan = upstreamPlan(repo, upstream, view.heads, tip);
  const landing = landingOf(repo, tip, view.into, plan.kind === "gone");
  if (landing === null) return kept({ kind: "unmerged", branch, into: view.into });
  if (plan.kind === "ahead") return kept({ kind: "upstream_ahead", branch, upstream: plan.tracking });
  return { kind: "landed", branch, tip, landing, into: view.into, plan };
}

export function hasPushedAndLanded(repo: string, branch: string, remotes: Remotes): boolean {
  const verdict = judge(repo, branch, remotes);
  return verdict.kind === "landed" && verdict.plan.kind !== "none";
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
      return { kind: "upstream_kept", branch, upstream: plan.tracking, detail: deleted.detail };
  }
  deleteBranchAt(repo, branch, tip);
  if (plan.kind === "gone") deleteRef(repo, plan.tracking);
  const upstreamDeleted = plan.kind === "delete" ? plan.tracking : null;
  return { kind: "deleted", branch, landing, into, upstream: upstreamDeleted };
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, "");
}

export function fateText(fate: BranchFate): string {
  switch (fate.kind) {
    case "detached":
      return "detached";
    case "deleted": {
      const upstream = fate.upstream === null ? "" : `, and ${shortRef(fate.upstream)} deleted`;
      return `branch ${fate.branch} deleted, ${fate.landing} into ${shortRef(fate.into)}${upstream}`;
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
    case "upstream_ahead":
      return `branch ${fate.branch} kept, ${shortRef(fate.upstream)} has commits it lacks`;
    case "upstream_kept":
      return `branch ${fate.branch} kept, deleting ${shortRef(fate.upstream)} failed: ${fate.detail}`;
    case "checked_out":
      return `branch ${fate.branch} kept, checked out at ${fate.at}`;
    default:
      return unreachable(fate);
  }
}
