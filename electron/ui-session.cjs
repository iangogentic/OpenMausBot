/**
 * The human-app bearer must never be a cookie: cookies are not port-scoped,
 * so a bot-controlled service on another loopback port could receive it from
 * an image request. Electron injects the header only for the exact harness
 * origin and strips any renderer-supplied copy everywhere else.
 */
function uiSessionRequestHeaders(appOrigin, token, requestUrl, inputHeaders = {}) {
  const headers = { ...inputHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-openmausbot-session") delete headers[name];
  }

  let targetOrigin = null;
  try {
    targetOrigin = new URL(requestUrl).origin;
  } catch {
    return headers;
  }
  if (targetOrigin === appOrigin) headers["X-OpenMausBot-Session"] = token;
  return headers;
}

module.exports = { uiSessionRequestHeaders };
