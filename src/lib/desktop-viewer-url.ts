export const DESKTOP_VIEWER_HOST = "openmaus-viewer.localhost";

export type DesktopViewerTransport = "proxied" | "hosted";

/** Resolve a server/provider join response without giving a browser fallback
 * a javascript:, data:, file:, credential, or cross-origin app-API escape.
 * Proxied noVNC is moved to a dedicated localhost origin whose server Host
 * serves viewer assets only; hosted Box viewers must be HTTPS. */
export function resolveDesktopViewerUrl(input: {
  rawUrl: string;
  appUrl: string;
  botId: string;
  transport: DesktopViewerTransport;
}): string {
  if (!input.rawUrl || input.rawUrl.length > 16_384) throw new Error("The live desktop returned an invalid link");
  if (!/^[\w-]+$/.test(input.botId)) throw new Error("The live desktop bot identity is invalid");
  const app = new URL(input.appUrl);
  const viewer = new URL(input.rawUrl, app);
  if (viewer.username || viewer.password) throw new Error("Live desktop links cannot use URL credentials");

  if (input.transport === "hosted") {
    if (viewer.protocol !== "https:") throw new Error("Hosted live desktops must use HTTPS");
    return viewer.toString();
  }

  const expectedPrefix = `/api/bots/${input.botId}/local-computer/viewer/`;
  const suffix = viewer.pathname.slice(expectedPrefix.length);
  if (
    !viewer.pathname.startsWith(expectedPrefix) ||
    !/^[A-Za-z0-9_-]{32,}\/vnc\.html$/.test(suffix) ||
    (viewer.origin !== app.origin && viewer.hostname !== DESKTOP_VIEWER_HOST) ||
    (viewer.protocol !== "http:" && viewer.protocol !== "https:")
  ) {
    throw new Error("The local live desktop link was not issued by this OpenMausBot server");
  }
  viewer.protocol = app.protocol;
  viewer.hostname = DESKTOP_VIEWER_HOST;
  viewer.port = app.port;
  return viewer.toString();
}
