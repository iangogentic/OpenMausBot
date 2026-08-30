import { Buffer } from "node:buffer";

/** Consume an Electron-main fetch response without allowing a peer to make
 * `text()`, `json()`, or `arrayBuffer()` allocate an unbounded body first. */
export async function readBoundedResponseBytes(response, maxBytes, tooLargeMessage) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("response byte cap is invalid");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(tooLargeMessage);
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel(tooLargeMessage).catch(() => {});
        throw new Error(tooLargeMessage);
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedResponseText(response, maxBytes, tooLargeMessage) {
  const bytes = await readBoundedResponseBytes(response, maxBytes, tooLargeMessage);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The remote response is not valid UTF-8");
  }
}

export async function readBoundedResponseJson(response, maxBytes, tooLargeMessage) {
  const text = await readBoundedResponseText(response, maxBytes, tooLargeMessage);
  return JSON.parse(text);
}
