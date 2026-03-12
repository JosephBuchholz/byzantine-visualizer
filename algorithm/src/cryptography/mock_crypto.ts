import ThresholdCryptoScheme from "./threshold_crypto.js";
import type { Signature, Key } from "./crypto_types.js";
import { isStringAnInteger } from "../utils/utils";

/**
 * A mock implementation of threshold cryptography.
 */
export default class MockCrypto extends ThresholdCryptoScheme {
  keygen(): [Key, Key[]] {
    const privateKeys = [];
    for (let i = 0; i < this.threshold; i++) {
      privateKeys.push("PrivateKey:" + i.toString());
    }

    return ["PublicKey", privateKeys];
  }

  sign(msg: string, private_key: Key): Signature {
    return "PartialSigned:" + private_key + ":" + msg;
  }

  combine(msg: string, partial_signatures: Signature[]): Signature | null {
    if (partial_signatures.length < this.threshold) {
      return null;
    }

    const intSignatures = new Set<number>(); // set to ensure no duplicates
    for (const signature of partial_signatures) {
      const sections = signature.split(":");
      if (sections.length === 4) {
        if (sections[0] === "PartialSigned" && sections[1] === "PrivateKey" && isStringAnInteger(sections[2])) {
          intSignatures.add(parseInt(sections[2], 10));
        }
      } else {
        return null;
      }
    }

    if (intSignatures.size < this.threshold) {
      return null;
    }

    return "Signed:" + msg;
  }

  verify(msg: string, signature: Signature, public_key: Key): boolean {
    if (public_key !== "PublicKey") {
      return false;
    }

    return "Signed:" + msg === signature;
  }
}
