import type { SendTurnInput } from "../../contracts.ts";

export interface AcpComputerOperatorServer {
  name: "computer_operator";
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Keep the ACP-specific serialization small and testable. The integration
 * already contains only a harness URL and exact-turn opaque capability. */
export function computerOperatorAcpServer(
  integration: NonNullable<NonNullable<SendTurnInput["integrations"]>["computerOperator"]> | undefined,
): AcpComputerOperatorServer | null {
  if (!integration) return null;
  return {
    name: "computer_operator",
    command: integration.command,
    args: [...integration.args],
    env: Object.entries(integration.env).map(([name, value]) => ({ name, value: String(value) })),
  };
}
