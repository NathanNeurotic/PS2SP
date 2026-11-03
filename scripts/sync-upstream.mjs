import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Only prepare the merge. The workflow validates it before pushing normally.
export function syncUpstream({ cwd = process.cwd(), upstream = "https://github.com/johnson-cooper/PS2SP.git" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("status", "--porcelain")) throw new Error("Sync requires a clean checkout");
  git("fetch", "--no-tags", upstream, "main");
  const target = git("rev-parse", "FETCH_HEAD");
  if (git("merge-base", "HEAD", target) === target) return false;
  try {
    git("merge", "--no-edit", target, "-m", "chore(mirror): sync upstream\n\nCo-authored-by: ChatGPT <noreply@openai.com>");
  } catch (error) {
    try { git("merge", "--abort"); } catch { /* No merge may have started. */ }
    throw new Error("Upstream merge failed; fork history preserved. Resolve in a PR before retrying.", { cause: error });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(syncUpstream() ? "Upstream merged locally; validation required before push." : "Upstream is already included.");
}
