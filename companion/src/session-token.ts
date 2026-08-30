// The standalone companion needs two independent capabilities: one to call
// the harness upstream and one for the desktop app to control pairing. They
// must never inherit through argv or a normal process environment.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const TOKEN = /^[A-Za-z0-9._~-]{32,512}$/;
export const SYSTEMD_HARNESS_SESSION_CREDENTIAL = "openmausbot-ui-session";
export const SYSTEMD_CONTROL_SESSION_CREDENTIAL = "openmausbot-companion-session";
// Compatibility name for callers that only validate one credential file.
export const SYSTEMD_SESSION_CREDENTIAL = SYSTEMD_HARNESS_SESSION_CREDENTIAL;

/** Read the systemd-provided credential through one descriptor. `O_NOFOLLOW`
 * and `fstat` bind the checks to the object actually read rather than to a
 * pathname an attacker could swap after `lstat`. The credential directory is
 * systemd's private mount, not a same-UID home-directory secret file.
 */
export function readSystemdSessionCredential(file: string | undefined): string | null {
  if (!file || !isAbsolute(file)) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
    const token = readFileSync(descriptor, "utf8").trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close does not turn an invalid credential into authority.
      }
    }
  }
}

/**
 * Extract the only approved headless session-token source, then remove its
 * path from the environment before anything else can inherit it. There is no
 * home-directory token-file fallback: a provider shell running as the same
 * Unix user could read it long after the companion's one startup read.
 */
export function takeHeadlessSessionTokens(environment: NodeJS.ProcessEnv = process.env): {
  harnessSessionToken: string | null;
  controlSessionToken: string | null;
} {
  const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
  delete environment.CREDENTIALS_DIRECTORY;
  const harnessCredential = credentialsDirectory
    ? join(credentialsDirectory, SYSTEMD_HARNESS_SESSION_CREDENTIAL)
    : undefined;
  const controlCredential = credentialsDirectory
    ? join(credentialsDirectory, SYSTEMD_CONTROL_SESSION_CREDENTIAL)
    : undefined;
  return {
    harnessSessionToken: readSystemdSessionCredential(harnessCredential),
    controlSessionToken: readSystemdSessionCredential(controlCredential),
  };
}

/** Retained for focused migration tests; new headless startup requires both. */
export function takeHeadlessSessionToken(environment: NodeJS.ProcessEnv = process.env): string | null {
  return takeHeadlessSessionTokens(environment).harnessSessionToken;
}
