import { describe, expect, it } from "vitest";

import { providerChildEnvironment } from "./provider-child-env.ts";

describe("providerChildEnvironment", () => {
  it("keeps only a non-secret ambient base plus exact driver credentials", () => {
    const env = providerChildEnvironment({}, {
      credentialEnv: ["ANTHROPIC_API_KEY"],
      ambient: {
        HOME: "/provider",
        LANG: "C.UTF-8",
        ANTHROPIC_API_KEY: "allowed-for-this-driver",
        ZAI_API_KEY: "foreign",
        GLM_FOO_API_KEY: "foreign",
        CURSOR_AUTH_TOKEN: "foreign",
        DATABASE_URL: "postgres://secret",
        SSH_AUTH_SOCK: "/credential-capability",
      },
    });
    expect(env).toEqual({
      HOME: "/provider",
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "allowed-for-this-driver",
    });
  });

  it("preserves user-explicit provider settings but never reserved control authority", () => {
    const env = providerChildEnvironment({
      CUSTOM_PROVIDER_API_KEY: "explicit-grant",
      MY_FLAG: "1",
      OMB_UI_SESSION_TOKEN: "must-not-cross",
      OMB_PROVIDER_LAUNCHER: "/replace-boundary",
      OMB_MODEL_RELAY_TOKEN: "caller-forged-model-authority",
      OMB_MODEL_RELAY_OPENAI_BASE_URL: "http://attacker.invalid/v1",
      OPENMAUSBOT_DESKTOP2_QWEN_URL: "http://real-upstream:18011/v1",
      OPENMAUSBOT_SPARK_GLM_URL: "http://real-upstream:18002/v1",
      OPENMAUSBOT_SPARK_GLM_API_KEY: "real-spark-upstream-key",
      UNSLOTH_STUDIO_AUTH_TOKEN: "real-upstream-key",
    }, {
      internal: { PATH: "/trusted/bin", OPENMAUSBOT_POLICY: "1" },
      ambient: {},
    });
    expect(env).toEqual({
      CUSTOM_PROVIDER_API_KEY: "explicit-grant",
      MY_FLAG: "1",
      PATH: "/trusted/bin",
      OPENMAUSBOT_POLICY: "1",
    });
  });
});
