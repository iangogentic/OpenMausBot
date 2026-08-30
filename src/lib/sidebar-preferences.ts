export type SidebarDensity = "comfortable" | "compact" | "icons";
export type ExpandedSidebarDensity = Exclude<SidebarDensity, "icons">;

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";
export const SIDEBAR_LAST_EXPANDED_DENSITY_KEY = "openmausbot.sidebarLastExpandedDensity";
export const SIDEBAR_WIDTH_KEY = "openmausbot.sidebarWidth";

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_COMFORTABLE_WIDTH = 320;
export const SIDEBAR_COMPACT_WIDTH = 272;
export const SIDEBAR_KEYBOARD_STEP = 8;

export function parseSidebarDensity(value: string | null): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return "comfortable";
  }
}

export function loadSidebarDensity(storage?: Pick<Storage, "getItem"> | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

export function parseExpandedSidebarDensity(value: string | null): ExpandedSidebarDensity {
  return value === "compact" ? "compact" : "comfortable";
}

export function loadLastExpandedSidebarDensity(
  storage?: Pick<Storage, "getItem"> | null,
): ExpandedSidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseExpandedSidebarDensity(target?.getItem(SIDEBAR_LAST_EXPANDED_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveLastExpandedSidebarDensity(
  density: ExpandedSidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_LAST_EXPANDED_DENSITY_KEY, density);
  } catch {
    // See saveSidebarDensity: a failed preference write must not break layout.
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseSidebarWidth(value: string | null, fallback = SIDEBAR_COMFORTABLE_WIDTH): number {
  if (value == null || value.trim() === "") return clampSidebarWidth(fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : clampSidebarWidth(fallback);
}

export function loadSidebarWidth(
  storage?: Pick<Storage, "getItem"> | null,
  fallback = SIDEBAR_COMFORTABLE_WIDTH,
): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarWidth(target?.getItem(SIDEBAR_WIDTH_KEY) ?? null, fallback);
  } catch {
    return clampSidebarWidth(fallback);
  }
}

export function saveSidebarWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // The current in-memory width remains usable when storage is unavailable.
  }
}

export function sidebarWidthForKey(
  current: number,
  key: string,
  shiftKey = false,
): number | null {
  const step = SIDEBAR_KEYBOARD_STEP * (shiftKey ? 4 : 1);
  if (key === "ArrowLeft") return clampSidebarWidth(current - step);
  if (key === "ArrowRight") return clampSidebarWidth(current + step);
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return SIDEBAR_MAX_WIDTH;
  return null;
}
