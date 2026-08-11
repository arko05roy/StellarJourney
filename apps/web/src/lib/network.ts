import type { DeploymentRecord, NetworkName } from "@paymap/contract-client";
import testnetDeployment from "../../../../deployments/testnet.json";

const VALID_NETWORKS: readonly NetworkName[] = ["testnet", "futurenet", "local", "mainnet"];

/** Resolves `STELLAR_NETWORK` (server-only env, read in a Server Component) into the typed `NetworkName` `loadDeployment` expects — fails loudly on an unrecognized value rather than silently falling back. */
export function resolveNetwork(): NetworkName {
  const raw = process.env.STELLAR_NETWORK ?? "testnet";
  if (!VALID_NETWORKS.includes(raw as NetworkName)) {
    throw new Error(
      `Invalid STELLAR_NETWORK "${raw}" — expected one of ${VALID_NETWORKS.join(", ")}`,
    );
  }
  return raw as NetworkName;
}

const WEB_DEPLOYMENTS: Partial<Record<NetworkName, DeploymentRecord>> = {
  testnet: testnetDeployment as DeploymentRecord,
};

/**
 * Returns deployment data bundled into the server artifact. Do not use the
 * filesystem-backed package loader here: serverless builds run from a
 * different path than the build workspace.
 */
export function resolveWebDeployment(): DeploymentRecord {
  const network = resolveNetwork();
  const deployment = WEB_DEPLOYMENTS[network];
  if (!deployment) {
    throw new Error(`No web deployment is bundled for network "${network}".`);
  }
  return deployment;
}
