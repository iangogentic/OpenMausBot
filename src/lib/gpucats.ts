import type { MausColor, MausMotion, MausState } from "@/lib/mascot";

/**
 * Reuse the existing persisted appearance color as the character slot. That
 * gives every saved bot and every group-message sender a stable GPU Cat with
 * no destructive migration, including older paired clients that only know
 * about `color`.
 */
export const GPU_CAT_CHARACTERS = [
  { id: "miso", label: "Miso", color: "green" },
  { id: "devcat1", label: "Developer", color: "blue" },
  { id: "devcat2", label: "Reviewer", color: "red" },
  { id: "devcat3", label: "Researcher", color: "orange" },
  { id: "devcat4", label: "Tester", color: "purple" },
  { id: "orange_tabby", label: "Orange Tabby", color: "cyan" },
  { id: "project_pm", label: "Project PM", color: "pink" },
  { id: "room_manager", label: "Room Manager", color: "yellow" },
] as const satisfies readonly { id: string; label: string; color: MausColor }[];

export type GpuCatCharacter = (typeof GPU_CAT_CHARACTERS)[number]["id"];
export type GpuCatAction =
  | "idle"
  | "typing"
  | "thinking"
  | "happy"
  | "confused"
  | "sleeping"
  | "walking"
  | "fly";

/** One stable profile choice per authored resting animation. */
export const GPU_CAT_PICKABLE_MOODS = [
  "idle",
  "happy",
  "thinking",
  "sleeping",
  "working",
  "confused",
] as const satisfies readonly MausState[];

const COLOR_TO_CHARACTER = {
  green: "miso",
  blue: "devcat1",
  red: "devcat2",
  orange: "devcat3",
  purple: "devcat4",
  cyan: "orange_tabby",
  pink: "project_pm",
  yellow: "room_manager",
  teal: "devcat1",
  coral: "orange_tabby",
} satisfies Record<MausColor, GpuCatCharacter>;

export function gpuCatForColor(color: MausColor): GpuCatCharacter {
  return COLOR_TO_CHARACTER[color] ?? "miso";
}

export function gpuCatActionForState(state: MausState): GpuCatAction {
  switch (state) {
    case "working":
    case "loading":
    case "dictating":
    case "writing":
    case "sending":
    case "receiving":
    case "uploading":
    case "progress":
      return "typing";
    case "thinking":
    case "searching":
    case "listening":
    case "curious":
    case "suspicious":
    case "orbit":
    case "radar":
      return "thinking";
    case "happy":
    case "excited":
    case "proud":
    case "playful":
    case "celebrate":
    case "laughing":
      return "happy";
    case "confused":
    case "surprised":
    case "angry":
    case "sad":
    case "scared":
    case "alerting":
    case "notifying":
    case "bored":
    case "shy":
      return "confused";
    case "sleeping":
    case "drowsy":
    case "powering-down":
      return "sleeping";
    case "waking":
    case "dragging":
    case "bouncing":
      return "walking";
    case "spawning":
    case "humming":
      return "fly";
    default:
      return "idle";
  }
}

export function gpuCatActionForMotion(motion: MausMotion): GpuCatAction | null {
  switch (motion) {
    case "arrive":
    case "switch":
    case "celebrate":
      return "fly";
    case "thinking":
      return "thinking";
    case "working":
    case "launch":
      return "typing";
    case "customize":
    case "success":
      return "happy";
    case "alert":
    case "surprise":
    case "failure":
      return "confused";
    default:
      return null;
  }
}

export function gpuCatAsset(
  color: MausColor,
  action: GpuCatAction,
  animated: boolean,
): string {
  return `/gpucats/${gpuCatForColor(color)}/${action}.${animated ? "webp" : "png"}`;
}
