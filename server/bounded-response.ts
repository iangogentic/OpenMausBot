/** Read an HTTP response without ever retaining more than the caller's cap.
 * `response.text()` / `json()` buffer the entire peer-controlled body before
 * a size check can run, which makes a nominal import limit useless against a
 * missing or dishonest Content-Length header. */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
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
  const chunks: Uint8Array[] = [];
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
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, maxBytes, tooLargeMessage);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The remote response is not valid UTF-8");
  }
}
