// The Box / Self-hosted VPS segmented control shown under the "Runs on"
// picker whenever a bot can end up on a cloud computer. One component, two
// homes (ComputerPanel and SettingsPanel), so the copy and the disabled
// rules can never drift apart.
import type { CloudBackend } from "../../server/contracts.ts";
import { useId } from "react";
import { cn } from "@/lib/cn";

export function CloudBackendPicker({
  value,
  vpsSupported,
  disabled = false,
  disabledReason,
  onChange,
}: {
  value: CloudBackend;
  vpsSupported: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (backend: CloudBackend) => void;
}) {
  const helpId = useId();
  const unavailableId = useId();
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">Hosted option</div>
      <div id={helpId} className="mt-0.5 text-[11.5px] text-ink-secondary">
        {value === "vps"
          ? "A separate desktop on your SSH-configured Linux host. Automatic reuses it only when ready unless Start VPS automatically is enabled."
          : "A separate hosted Box desktop. It is not the OpenMaus server or its isolated Linux desktop."}
      </div>
      <div
        className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40"
        role="group"
        aria-label="Hosted desktop option"
        aria-describedby={`${helpId} ${unavailableId}`}
      >
        {(["box", "vps"] as const).map((backend, i) => {
          const optionDisabled = disabled || (backend === "vps" && !vpsSupported);
          return (
            <button
              key={backend}
              aria-pressed={value === backend}
              disabled={optionDisabled}
              title={backend === "vps" && !vpsSupported ? "Remote VPS requires Claude or an ACP engine" : undefined}
              onClick={() => onChange(backend)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                optionDisabled && "cursor-not-allowed opacity-40",
                value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {backend === "vps" ? "Remote VPS" : "Hosted Box"}
            </button>
          );
        })}
      </div>
      <div id={unavailableId} className="mt-1.5 text-[11px] text-ink-secondary">
        {disabled
          ? disabledReason ?? "Hosted-option changes are currently locked."
          : vpsSupported
            ? "Both hosted options are available."
            : "Remote VPS is unavailable with this engine."}
      </div>
    </div>
  );
}
