/**
 * Matrix E2EE Crypto Utilities
 *
 * Handles initialization and management of Matrix end-to-end encryption.
 * Uses rust crypto via initRustCrypto() for Node.js.
 *
 * Based on the reference implementation approach:
 * - Uses bootstrapSecretStorage with recovery key
 * - Uses bootstrapCrossSigning for cross-signing setup
 * - Sets trust to allow unverified devices (TOFU model)
 */

import { createLogger } from '../logger.js';
import type { MatrixClient, ICryptoCallbacks } from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';

const log = createLogger('MatrixCrypto');

export interface CryptoConfig {
  enableEncryption: boolean;
  recoveryKey?: string;
  storeDir: string;
  password?: string;
  userId?: string;
}

/**
 * Get crypto callbacks for the Matrix client.
 * These are needed for secret storage operations.
 */
export function getCryptoCallbacks(recoveryKey?: string): ICryptoCallbacks {
  return {
    getSecretStorageKey: async (
      { keys }: { keys: Record<string, unknown> },
      _name: string,
    ): Promise<[string, Uint8Array] | null> => {
      if (!recoveryKey) {
        log.info('No recovery key provided, cannot retrieve secret storage key');
        return null;
      }

      const keyIds = Object.keys(keys);
      if (keyIds.length === 0) {
        log.info('No secret storage key IDs requested');
        return null;
      }

      const keyId = keyIds[0];
      log.info(`Providing secret storage key for keyId: ${keyId}`);

      try {
        const keyBytes = decodeRecoveryKey(recoveryKey);
        log.info(`Decoded recovery key, length: ${keyBytes.length} bytes`);
        return [keyId, keyBytes];
      } catch (err) {
        log.error('Failed to decode recovery key:', err);
        return null;
      }
    },
    cacheSecretStorageKey: (keyId: string, _keyInfo: unknown, _key: Uint8Array): void => {
      log.info(`Cached secret storage key: ${keyId}`);
    },
  };
}

/**
 * Initialize E2EE for a Matrix client using rust crypto.
 *
 * 1. Initialize rust crypto (ephemeral mode — no IndexedDB persistence)
 * 2. Bootstrap secret storage with recovery key
 * 3. Bootstrap cross-signing
 * 4. Set trust settings for TOFU (Trust On First Use)
 */
export async function initE2EE(
  client: MatrixClient,
  config: CryptoConfig,
): Promise<void> {
  if (!config.enableEncryption) {
    log.info('Encryption disabled');
    return;
  }

  log.info('E2EE enabled');

  try {
    // useIndexedDB: false — ephemeral crypto mode.
    // Rust WASM crypto triggers TransactionInactiveError with IndexedDB persistence.
    // Workaround: fresh device on every restart, cross-signing auto-verifies.
    log.info('Initializing rust crypto (ephemeral mode)...');

    await client.initRustCrypto({ useIndexedDB: false });

    const crypto = client.getCrypto();
    if (!crypto) {
      throw new Error('Crypto not initialized after initRustCrypto');
    }

    log.info('Rust crypto initialized');

    // Trigger outgoing request loop to upload device keys.
    // Without this, the device shows as "doesn't support encryption".
    log.info('Triggering key upload...');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).outgoingRequestLoop?.();
    await new Promise(resolve => setTimeout(resolve, 2000));
    log.info('Key upload triggered');

    // Force a device key query for this user
    if (config.userId) {
      log.info('Fetching device list...');
      try {
        await crypto.getUserDeviceInfo([config.userId]);
        await new Promise(resolve => setTimeout(resolve, 2000));
        log.info('Device list fetched');
      } catch (err) {
        log.warn('Failed to fetch device list:', err);
      }
    }

    // Import backup decryption key from recovery key
    if (config.recoveryKey) {
      log.info('Importing backup decryption key from recovery key...');
      try {
        const backupKey = decodeRecoveryKey(config.recoveryKey);
        await crypto.storeSessionBackupPrivateKey(backupKey);
        log.info('Backup decryption key stored successfully');
      } catch (err) {
        log.warn('Failed to store backup key:', err);
      }

      log.info('Bootstrapping secret storage...');
      try {
        await crypto.bootstrapSecretStorage({});
        log.info('Secret storage bootstrapped');
      } catch (err) {
        log.warn('Secret storage bootstrap failed (may already exist):', err);
      }

      // Bootstrap cross-signing — reads existing keys from secret storage.
      // DO NOT use setupNewCrossSigning: true as that would create new keys.
      log.info('Bootstrapping cross-signing...');
      try {
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => {
            log.info('Uploading cross-signing keys with auth...');
            if (config.password && config.userId) {
              await makeRequest({
                type: 'm.login.password',
                user: config.userId,
                password: config.password,
              });
              return;
            }
            await makeRequest({});
          },
        });
        log.info('Cross-signing bootstrapped');
      } catch (err) {
        log.warn('Cross-signing bootstrap failed:', err);
      }
    }

    // Enable trusting cross-signed devices (TOFU model).
    // Allows the bot to receive encrypted messages without interactive verification.
    crypto.setTrustCrossSignedDevices(true);

    // Disable global blacklist of unverified devices.
    // The bot will encrypt for and accept key requests from unverified devices.
    crypto.globalBlacklistUnverifiedDevices = false;
    log.info('Trusting cross-signed devices enabled, unverified devices globally allowed');

    log.info('Crypto initialization complete');
  } catch (err) {
    log.error('Failed to initialize crypto:', err);
    throw err;
  }
}

/**
 * Check and enable key backup after sync completes.
 * Must be called AFTER the initial sync so device list is populated.
 */
export async function checkAndRestoreKeyBackup(
  client: MatrixClient,
  recoveryKey?: string,
): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto || !recoveryKey) return;

  log.info('Checking key backup after sync...');
  try {
    const backupInfo = await crypto.checkKeyBackupAndEnable();
    if (backupInfo) {
      log.info('Key backup enabled');
      try {
        await client.getKeyBackupVersion();
        log.info('Backup version exists on server');

        log.info('Restoring keys from backup...');
        const backupKey = decodeRecoveryKey(recoveryKey);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const restoreResult = await (client as any).restoreKeyBackup(
          backupKey,
          undefined, // all rooms
          undefined, // all sessions
          backupInfo.backupInfo,
        );
        log.info(`Restored ${restoreResult.imported} keys from backup`);
      } catch (backupErr: unknown) {
        const err = backupErr as { errcode?: string; httpStatus?: number };
        if (err.errcode === 'M_NOT_FOUND' || err.httpStatus === 404) {
          log.info('Key backup not found on server, skipping restore');
        } else {
          log.warn('Error accessing key backup:', backupErr);
        }
      }
    } else {
      log.info('No trusted key backup available');
    }
  } catch (err) {
    log.warn('Key backup check failed:', err);
  }
}

/**
 * Mark all devices for a user as verified (TOFU — Trust On First Use).
 */
export async function trustUserDevices(
  client: MatrixClient,
  userId: string,
): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) return;

  try {
    log.info(`Trusting devices for ${userId}...`);

    const devices = await crypto.getUserDeviceInfo([userId]);
    const userDevices = devices.get(userId);

    if (!userDevices || userDevices.size === 0) {
      log.info(`No devices found for ${userId}`);
      return;
    }

    let verifiedCount = 0;
    for (const [deviceId] of Array.from(userDevices.entries())) {
      if (deviceId === client.getDeviceId()) continue;

      const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
      if (!status?.isVerified()) {
        log.info(`Marking device ${deviceId} as verified`);
        await crypto.setDeviceVerified(userId, deviceId, true);
        verifiedCount++;
      }
    }

    log.info(`Verified ${verifiedCount} devices for ${userId}`);
  } catch (err) {
    log.error(`Failed to trust devices for ${userId}:`, err);
  }
}
