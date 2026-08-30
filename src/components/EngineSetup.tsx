// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useState } from "react";
import { Check, Copy, Download, ExternalLink, LogIn, TerminalSquare } from "lucide-react";
import type { EngineInstall, InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = typeof window === "undefined" ? undefined : window.ogb?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined, platform = hostPlatform()): string | null {
  return install?.command?.[platform] ?? null;
}

export function engineSetupPlan(
  install: EngineInstall | undefined,
  connection: "local" | "remote" | "browser",
  serverPlatform?: Platform,
): { command: string | null; runOnServer: boolean } {
  // A remote server is the sole authority for engine installation. If an old
  // harness has not reported its platform yet, withhold the command rather
  // than guessing from the controller Mac and launching the wrong terminal.
  if (connection === "remote") {
    return { command: serverPlatform ? installCommandFor(install, serverPlatform) : null, runOnServer: true };
  }
  return { command: installCommandFor(install), runOnServer: false };
}

/** Installed but missing the cloud account session. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

/** The agent CLI itself is absent. Local-model injection needs the CLI but
 * does not need its cloud account to be signed in. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
}

function CommandRow({ command, actionLabel, canOpenTerminal }: { command: string; actionLabel: string; canOpenTerminal: boolean }) {
  const [status, setStatus] = useState<"copied" | "opened" | null>(null);
  const canOpen = canOpenTerminal && Boolean(window.ogb?.openInstallTerminal);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      settle("copied");
    } catch {
      // The command remains selectable when clipboard access is blocked.
    }
  };

  const openTerminal = async () => {
    const opened = await window.ogb!.openInstallTerminal!(command);
    settle(opened ? "opened" : "copied");
  };

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy command"
            title="Copy command"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className="mt-2 flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" ? "Terminal opened" : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? "Paste the command and press Enter." : "The command is copied when Terminal opens."}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? "Command copied" : "Copy command"}
        </button>
      )}
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
}) {
  const { capabilities } = useDesktopCapabilities();
  const install = instance.install;
  const remote = capabilities.connection?.mode === "remote";
  const plan = engineSetupPlan(install, remote ? "remote" : capabilities.connection?.mode ?? "browser", instance.hostPlatform);
  const installCommand = plan.command;
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly ? `Sign in to ${instance.displayName}` : `Install ${instance.displayName}`;
  const description = signInOnly
    ? remote
      ? "Run this on the Razer server, then return here and check again."
      : "Finish the account sign-in in Terminal. Reopen this menu afterward and we’ll check again."
    : intent === "inject"
      ? remote
        ? "Install this on the Razer server once, then you can run it with local models—no cloud sign-in required."
        : "Install the agent once, then you can run it with local models—no cloud sign-in required."
      : remote
        ? `Install the command-line app on Razer. Models will appear here as soon as its server detects it${signInCommand ? "; sign-in may follow" : ""}.`
        : `Install the command-line app once. Models will appear here as soon as it’s ready${signInCommand ? "; sign-in may follow" : ""}.`;

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{instance.displayName} isn’t ready</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? "This engine is not available on this machine."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {command ? (
        <CommandRow
          command={command}
          canOpenTerminal={!plan.runOnServer}
          actionLabel={
            plan.runOnServer
              ? "Copy command for Razer"
              : signInOnly
                ? "Open sign-in in Terminal"
                : "Open install in Terminal"
          }
        />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {plan.runOnServer
            ? "Razer has not reported a supported install command yet. Use the setup guide on Razer; this Mac will not open a local terminal."
            : "There isn’t a one-line installer for this platform. Use the setup guide below."}
        </p>
      )}

      {plan.runOnServer && command && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Copy this, SSH to Razer, and run it there. This controller never installs engines on your Mac.
        </p>
      )}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Requires Node.js and <code className="font-mono">npm</code>.
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> View setup guide
        </a>
      )}
    </div>
  );
}
