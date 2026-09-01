import { z } from "zod";

const httpError = z.object({
  status: z.number().int().min(400).max(599),
});

/** Child-process errors also expose a numeric `status`, but that value is an
 * exit code rather than an HTTP status. Never hand it to ServerResponse. */
export function httpStatusForError(error: unknown): number {
  const parsed = httpError.safeParse(error);
  return parsed.success ? parsed.data.status : 500;
}
