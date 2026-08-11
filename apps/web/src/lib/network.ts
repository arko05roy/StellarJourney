import type { NetworkName } from "@paymap/contract-client";

const VALID_NETWORKS: readonly NetworkName[] = ["testnet", "futurenet", "local", "mainnet"];

/** Resolves `STELLAR_NETWORK` (server-only env, read in a Server Component) into the typed `NetworkName` `loadDeployment` expects — fails loudly on an unrecognized value rather than silently falling back. */
export function resolveNetwork(): NetworkName {
  const raw = process.env.STELLAR_NETWORK ?? "testnet";
  if (!VALID_NETWORKS.includes(raw as NetworkName)) {
    throw new Error(`Invalid STELLAR_NETWORK "${raw}" — expected one of ${VALID_NETWORKS.join(", ")}`);
  }
  return raw as NetworkName;
}
