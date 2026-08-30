// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validateBotCwd(
  input: unknown,
  options: { workspacesRoot?: string } = {},
): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  const configuredRoot = options.workspacesRoot ?? process.env.OMB_WORKSPACES_DIR?.trim();
  if (configuredRoot) {
    try {
      const root = realpathSync(resolve(configuredRoot));
      const canonical = realpathSync(cwd);
      if (!inside(root, canonical)) {
        return {
          ok: false,
          error: `remote working folders must stay inside the managed workspace root: ${root}`,
        };
      }
      return { ok: true, cwd: canonical };
    } catch {
      return { ok: false, error: "the managed workspace root is unavailable" };
    }
  }
  return { ok: true, cwd };
}
