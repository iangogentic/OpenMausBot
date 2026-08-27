#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CHARACTERS = [
  "miso",
  "devcat1",
  "devcat2",
  "devcat3",
  "devcat4",
  "orange_tabby",
  "project_pm",
  "room_manager",
];
const ACTIONS = ["idle", "typing", "thinking", "happy", "confused", "sleeping", "walking", "fly"];
const SOURCE_FRAME = { width: 788, height: 504 };
const MIN_CROP_SIZE = 320;
const MAX_CROP_SIZE = 420;
const CROP_PADDING = 40;
const OUTPUT_SIZE = 256;
const FRAME_DURATIONS_MS = {
  idle: 90,
  sleeping: 140,
  thinking: 90,
  typing: 70,
  happy: 60,
  confused: 70,
  walking: 55,
  fly: 70,
};

const sourceArgument = process.argv[2] ?? process.env.GPUCATS_ASSETS_DIR;
if (!sourceArgument) {
  throw new Error("Usage: node scripts/package-gpucats-assets.mjs <GPU Cats Assets/animations path> [output]");
}
const sourceRoot = resolve(sourceArgument);
const outputRoot = resolve(process.argv[3] ?? "public/gpucats");
const workRoot = join(tmpdir(), `openmaus-gpucats-${process.pid}`);

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const numbered = (name) => Number(name.match(/_(\d+)\.png$/)?.[1] ?? Number.MAX_SAFE_INTEGER);

if (!existsSync(sourceRoot)) throw new Error(`GPU Cats animation source does not exist: ${sourceRoot}`);

function actionFrames(character, action) {
  const directory = join(sourceRoot, character, "frames");
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${action}_`) && name.endsWith(".png"))
    .sort((a, b) => numbered(a) - numbered(b))
    .map((name) => join(directory, name));
}

function unionBounds(frames) {
  const geometry = run("magick", [
    ...frames,
    "-alpha",
    "extract",
    "-evaluate-sequence",
    "max",
    "-trim",
    "-format",
    "%wx%h%X%Y",
    "info:",
  ]);
  const match = geometry.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
  if (!match) throw new Error(`Could not parse ImageMagick geometry: ${geometry}`);
  return { width: Number(match[1]), height: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

function cropSize(bounds) {
  const padded = Math.max(bounds.width, bounds.height) + CROP_PADDING;
  return Math.max(MIN_CROP_SIZE, Math.min(MAX_CROP_SIZE, Math.ceil(padded / 4) * 4));
}

function cropOrigin(bounds, size) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    x: Math.max(0, Math.min(SOURCE_FRAME.width - size, Math.round(centerX - size / 2))),
    y: Math.max(0, Math.min(SOURCE_FRAME.height - size, Math.round(centerY - size / 2))),
  };
}

mkdirSync(workRoot, { recursive: true });
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const manifest = {
  version: 1,
  source: "GPU Cats Assets/animations",
  sourceFrame: SOURCE_FRAME,
  outputSize: OUTPUT_SIZE,
  frameDurationsMs: FRAME_DURATIONS_MS,
  characters: {},
  actions: ACTIONS,
};

try {
  for (const character of CHARACTERS) {
    const characterOut = join(outputRoot, character);
    mkdirSync(characterOut, { recursive: true });
    manifest.characters[character] = {};

    for (const action of ACTIONS) {
      const frames = actionFrames(character, action);
      if (!frames.length) throw new Error(`No ${action} frames found for ${character}`);
      const bounds = unionBounds(frames);
      const size = cropSize(bounds);
      const origin = cropOrigin(bounds, size);
      const actionWork = join(workRoot, character, action);
      mkdirSync(actionWork, { recursive: true });

      const processed = frames.map((frame, index) => {
        const output = join(actionWork, `${String(index).padStart(3, "0")}.png`);
        run("magick", [
          frame,
          "-crop",
          `${size}x${size}+${origin.x}+${origin.y}`,
          "+repage",
          "-filter",
          "Lanczos",
          "-resize",
          `${OUTPUT_SIZE}x${OUTPUT_SIZE}`,
          output,
        ]);
        return output;
      });

      const animatedName = `${action}.webp`;
      const posterName = `${action}.png`;
      run("img2webp", [
        "-loop",
        "0",
        "-mixed",
        "-m",
        "6",
        "-q",
        "88",
        ...processed.flatMap((frame) => ["-d", String(FRAME_DURATIONS_MS[action]), frame]),
        "-o",
        join(characterOut, animatedName),
      ]);
      run("magick", [processed[0], "-strip", join(characterOut, posterName)]);

      manifest.characters[character][action] = {
        animated: animatedName,
        poster: posterName,
        frames: frames.length,
        frameDurationMs: FRAME_DURATIONS_MS[action],
        crop: { ...origin, size },
      };
      process.stdout.write(`${character}/${action}: ${frames.length} frames (${basename(animatedName)})\n`);
    }
  }

  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outputRoot, "README.md"),
    [
      "# GPU Cats runtime assets",
      "",
      "Generated from the canonical GPU Cats `Assets/animations` frame library by",
      "`scripts/package-gpucats-assets.mjs`. Do not hand-edit the generated PNG/WebP files.",
      "",
      "Each character/action pair includes an animated WebP and a static PNG poster.",
      "Every action is cropped from its alpha-union bounds so all frames remain aligned.",
      "",
    ].join("\n"),
  );
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
