// Bot avatar — the canonical GPU Cats cast, wrapped in the app's historical
// MausAvatar API so every existing surface (sidebar, chat, calls, rooms,
// routines and onboarding) receives the same animated character renderer.
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { MausColor, MausMotion, MausState } from "@/lib/mascot";
import { gpuCatActionForMotion, gpuCatActionForState, gpuCatAsset } from "@/lib/gpucats";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";

/** Legacy preview-harness knobs retained for source compatibility. */
export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

export type MausAvatarHandle = {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
};

export type MausAvatarProps = {
  color: MausColor;
  /** Named behaviour — selects the closest authored GPU Cats action. */
  state?: MausState;
  /** Legacy preview-harness input. GPU Cats use named actions instead. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off restores the engine's own drawn-in directions.
   */
  forward?: boolean;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting face. */
  animated?: boolean;
  /** Legacy Maus face-placement knobs — accepted, ignored. */
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function MausAvatarComponent(
  {
    color,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn: _turn,
    gaze: _gaze,
    spring: _spring,
    eyeScale: _eyeScale,
    showMouth: _showMouth,
    mouthStroke: _mouthStroke,
    forward: _forward = true,
    trackPointer: _trackPointer = true,
    animated = true,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const [imperativeKey, setImperativeKey] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const spinTimer = useRef<number | null>(null);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useImperativeHandle(ref, () => ({
    blink: () => setImperativeKey((key) => key + 1),
    spin: (durationMs = 700) => {
      if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
      setSpinning(false);
      window.requestAnimationFrame(() => setSpinning(true));
      spinTimer.current = window.setTimeout(() => {
        setSpinning(false);
        spinTimer.current = null;
      }, durationMs);
    },
    setExpression: () => setImperativeKey((key) => key + 1),
  }));
  useEffect(() => () => {
    if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
  }, []);

  // A one-shot motion borrows an action for a moment, then hands control back
  // to the bot's live state. Changing the key restarts the WebP at frame one.
  const [motionAction, setMotionAction] = useState<ReturnType<typeof gpuCatActionForMotion>>(null);
  const shouldAnimate = animated && !reduceMotion;
  useEffect(() => {
    if (motion === "none" || !shouldAnimate) {
      setMotionAction(null);
      return;
    }
    const action = gpuCatActionForMotion(motion);
    if (!action) return;
    setMotionAction(action);
    const timer = window.setTimeout(() => setMotionAction(null), 1400);
    return () => clearTimeout(timer);
  }, [motion, motionKey, shouldAnimate]);

  const action = motionAction ?? gpuCatActionForState(state);
  const source = gpuCatAsset(color, action, shouldAnimate);

  return (
    <span
      className={`gpu-cat-avatar inline-flex shrink-0 ${spinning ? "gpu-cat-avatar--spin" : ""}`}
      style={{ width: size, height: size }}
    >
      <img
        key={`${source}:${motionKey}:${imperativeKey}:${expression ?? "auto"}`}
        src={source}
        alt={label ?? "GPU Cat agent"}
        title={label}
        width={size}
        height={size}
        draggable={false}
        className="block size-full object-contain"
        onError={(event) => {
          event.currentTarget.onerror = null;
          event.currentTarget.src = "/gpucats/miso/idle.png";
        }}
      />
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: MausColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
  };
};

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the animated mascot,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  if (profile.avatarCrop === "mascot" || !profile.avatarUrl || imageFailed) {
    return (
      <MausAvatar
        {...mascotProps}
        color={bot.color}
        size={size}
        label={label ?? bot.name}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
