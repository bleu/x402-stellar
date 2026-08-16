import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import { Env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { UptoStellarScheme } from "./upto/scheme.js";

/**
 * Builds the exact-scheme handler from env config. Two modes:
 * single signer (default), or channel accounts + fee-bump signer for
 * parallel submission when FACILITATOR_STELLAR_CHANNEL_SECRETS is set.
 */
export function createExactStellarScheme(): ExactStellarScheme {
  const feeBumpSecret = Env.feeBumpSecret;
  const channelSecrets = Env.channelSecrets;
  const useChannelAccounts = feeBumpSecret && channelSecrets && channelSecrets.length > 0;
  const rpcConfig = { url: Env.stellarRpcUrl };
  const maxTransactionFeeStroops = Env.maxTransactionFeeStroops;

  if (useChannelAccounts) {
    const channelSigners = channelSecrets.map((secret) => createEd25519Signer(secret));
    const feeBumpSigner = createEd25519Signer(feeBumpSecret);

    logger.info(
      {
        feeBumpAddress: feeBumpSigner.address,
        channelCount: channelSigners.length,
        channelAddresses: channelSigners.map((s) => s.address),
      },
      "High-throughput mode: fee-bump signer + channel accounts",
    );

    return new ExactStellarScheme(channelSigners, {
      feeBumpSigner,
      rpcConfig,
      maxTransactionFeeStroops,
    });
  }

  const stellarSigner = createEd25519Signer(Env.stellarPrivateKey);
  logger.info(`Stellar Facilitator account: ${stellarSigner.address}`);
  return new ExactStellarScheme([stellarSigner], {
    rpcConfig,
    maxTransactionFeeStroops,
  });
}

/**
 * Builds the upto-scheme handler when UPTO_CONTRACT_ID is set, otherwise
 * returns undefined so the facilitator serves exact only.
 */
export function createUptoStellarScheme(): UptoStellarScheme | undefined {
  const contractId = Env.uptoContractId;
  if (!contractId) return undefined;

  logger.info({ contract: contractId }, "upto scheme enabled");
  return new UptoStellarScheme({
    contractId,
    facilitatorSecret: Env.stellarPrivateKey,
    rpcUrl: Env.stellarRpcUrl,
    network: Env.stellarNetwork,
    maxTransactionFeeStroops: Env.maxTransactionFeeStroops,
  });
}
