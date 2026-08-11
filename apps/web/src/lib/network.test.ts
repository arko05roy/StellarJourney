import { afterEach, describe, expect, it } from "vitest";
import { resolveWebDeployment } from "./network";

const originalNetwork = process.env.STELLAR_NETWORK;

afterEach(() => {
  if (originalNetwork === undefined) {
    delete process.env.STELLAR_NETWORK;
  } else {
    process.env.STELLAR_NETWORK = originalNetwork;
  }
});

describe("resolveWebDeployment", () => {
  it("returns the statically bundled testnet deployment", () => {
    process.env.STELLAR_NETWORK = "testnet";

    const deployment = resolveWebDeployment();

    expect(deployment.network).toBe("testnet");
    expect(deployment.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(deployment.contractId).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("rejects a valid network without a bundled web deployment", () => {
    process.env.STELLAR_NETWORK = "mainnet";

    expect(() => resolveWebDeployment()).toThrow(
      'No web deployment is bundled for network "mainnet".',
    );
  });
});
