/**
 * Production configuration loader: canonical env (`@paymap/config`), the
 * committed deployment registry, and the relayer's own signer (never a
 * merchant's — see `chain-gateway.ts`'s module doc for what is deliberately
 * *not* solved here).
 */
import { getEnv } from "@paymap/config";
import { loadDeployment, type DeploymentRecord } from "@paymap/contract-client";
import { keypairSigner, type KeypairSigner } from "@paymap/stellar";

export interface RelayerConfig {
  databaseUrl: string;
  redisUrl: string;
  deployment: DeploymentRecord;
  relayerSigner: KeypairSigner;
  webhookEncryptionKey: string;
}

export function loadRelayerConfig(): RelayerConfig {
  const env = getEnv();
  const deployment = loadDeployment(env.STELLAR_NETWORK);
  const relayerSigner = keypairSigner(env.RELAYER_SECRET_KEY);
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    deployment,
    relayerSigner,
    webhookEncryptionKey: env.WEBHOOK_ENCRYPTION_KEY,
  };
}
