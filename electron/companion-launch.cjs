function companionChildEnvironment(baseEnvironment, options) {
  const environment = { ...baseEnvironment };
  delete environment.OMB_COMPANION_HOSTED_URL;
  delete environment.OMB_COMPANION_INTERNAL_ORIGIN;
  delete environment.OMB_UI_SESSION_TOKEN;
  delete environment.OMB_COMPANION_SESSION_TOKEN;
  if (options.hostedUrl) environment.OMB_COMPANION_HOSTED_URL = options.hostedUrl;
  environment.OMB_COMPANION_INTERNAL_ORIGIN = options.socketPath;
  environment.OMB_PORT = String(options.harnessPort);
  environment.OMB_COMPANION_PORT = String(options.companionPort);
  environment.OMB_CONTROL_PORT = String(options.controlPort);
  return environment;
}

function companionSessionMessage(harnessSessionToken, controlSessionToken) {
  return {
    type: "openmausbot:companion-sessions",
    harnessSessionToken: typeof harnessSessionToken === "string" ? harnessSessionToken : "",
    controlSessionToken: typeof controlSessionToken === "string" ? controlSessionToken : "",
  };
}

module.exports = { companionChildEnvironment, companionSessionMessage };
