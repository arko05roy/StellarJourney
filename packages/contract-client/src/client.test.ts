import { describe, expect, it } from "vitest";
import { createMandateRegistryClient } from "./client.js";
import type { DeploymentRecord } from "./deployment-registry.js";

const deployment: DeploymentRecord = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22",
  wasmHash: "00".repeat(32),
  deployedAt: "2026-07-27T17:17:54.889Z",
  rpcUrl: "https://soroban-testnet.stellar.org",
  asset: {
    code: "PUSD",
    issuer: "GCPQA5BPDIMI6P3LRIDCKVBOAFU35VKCCWDNZN4N6QRLX4ZJUQKZTHBT",
    contractId: "CB223VUC7MMCFT352EO7QLLV6QWHXTDOXOHY2BW7DZTO3VXBXAI7DUZJ",
    decimals: 7,
  },
};

describe("createMandateRegistryClient", () => {
  it("attaches the generated contract error names for live simulation decoding", () => {
    const client = createMandateRegistryClient(deployment);

    expect(client.options.errorTypes?.[4]).toEqual({ message: "MandateRevoked" });
    expect(client.spec.errorCases().find((errorCase) => errorCase.value() === 4)?.doc().toString()).toBe("MandateRevoked");
  });
});
