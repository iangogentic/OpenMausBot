import { describe, expect, it } from "vitest";

import { computerOperatorAcpServer } from "./computer-operator.ts";

describe("ACP computer operator integration", () => {
  it("mounts only the supplied blocking proxy command and opaque environment", () => {
    expect(computerOperatorAcpServer({
      command: "/runtime/node",
      args: ["/runtime/computer-operator-proxy.js"],
      env: { OMB_HARNESS_URL: "http://10.0.2.2:8799", OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN: "opaque" },
    })).toEqual({
      name: "computer_operator",
      command: "/runtime/node",
      args: ["/runtime/computer-operator-proxy.js"],
      env: [
        { name: "OMB_HARNESS_URL", value: "http://10.0.2.2:8799" },
        { name: "OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN", value: "opaque" },
      ],
    });
  });
});
