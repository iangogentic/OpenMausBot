function safeFileName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 180) return null;
  return /^[^/\\\0\x00-\x1f\x7f]+$/.test(value) ? value : null;
}

/** Decode the server's ASCII-only base64url header into a save-dialog hint.
 * Canonical spelling and an exact UTF-8 round trip prevent malformed bytes
 * from becoming a different local filename. */
function remoteDownloadName(encodedValue, legacyValue = null) {
  if (typeof encodedValue === "string" && /^[A-Za-z0-9_-]{1,1368}$/.test(encodedValue)) {
    const bytes = Buffer.from(encodedValue, "base64url");
    const decoded = bytes.toString("utf8");
    if (
      bytes.length > 0 &&
      bytes.length <= 1024 &&
      bytes.toString("base64url") === encodedValue &&
      Buffer.from(decoded, "utf8").equals(bytes)
    ) {
      return safeFileName(decoded) ?? "attachment";
    }
  }
  // Compatibility with a server that has not yet been atomically upgraded.
  return safeFileName(legacyValue) ?? "attachment";
}

module.exports = { remoteDownloadName };
