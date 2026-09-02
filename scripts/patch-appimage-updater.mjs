// electron-updater normally renames a versioned AppImage during update, which
// breaks desktop entries and dock pins. Keep the launched path and replace it
// atomically only after the staged download is ready.
const RENAME_ASSIGNMENT = /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;
const UNLINK_BEFORE_INSTALL = /^\s*\(0, fs_1\.unlinkSync\)\(appImageFile\);\n/m;
const MOVE_INTO_PLACE = /\(0, child_process_1\.execFileSync\)\("mv", \["-f", installerPath, destination\]\);/;

const REPLACEMENTS = [
  ["rename branch", RENAME_ASSIGNMENT, "destination = appImageFile;"],
  ["unlink before install", UNLINK_BEFORE_INSTALL, ""],
  [
    "move into place",
    MOVE_INTO_PLACE,
    [
      'const stagedDestination = `${destination}.new`;',
      '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination]);',
      "(0, fs_1.renameSync)(stagedDestination, destination);",
    ].join("\n        "),
  ],
];

export function patchAppImageUpdater(source) {
  let patched = source;
  for (const [label, pattern, replacement] of REPLACEMENTS) {
    const found = patched.match(pattern);
    const count = found ? (pattern.global ? found.length : 1) : 0;
    if (count !== 1) {
      throw new Error(`Expected exactly 1 AppImage "${label}" site to patch, found ${count}.`);
    }
    patched = patched.replace(pattern, replacement);
  }
  return patched;
}
