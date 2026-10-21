import { getPublicKeyAsync, signAsync } from "@noble/ed25519";

/**
 * The only server-side signing capability is Guard's. Production deployments
 * inject a KMS/HSM implementation; the local implementation reads the
 * documented development key from the environment.
 */
export interface KmsSigner {
  sign(message: Uint8Array): Promise<Uint8Array>;
  publicKey(): Promise<Uint8Array>;
}

export class EnvKmsSigner implements KmsSigner {
  constructor(private readonly privateKey: Uint8Array) {
    if (privateKey.length !== 32) {
      throw new Error("GUARD_ED25519_PRIVATE_KEY_BASE64 must decode to 32 bytes");
    }
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return signAsync(message, this.privateKey);
  }

  async publicKey(): Promise<Uint8Array> {
    return getPublicKeyAsync(this.privateKey);
  }
}
