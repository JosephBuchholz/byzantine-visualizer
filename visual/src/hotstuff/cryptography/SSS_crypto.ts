/* eslint-disable @typescript-eslint/no-unused-vars */

import ThresholdCryptoScheme from "./threshold_crypto";
import type { Signature, Key } from "./crypto_types";

/**
 * An implementation of Shamir Secret Sharing.
 */
export default class SSS extends ThresholdCryptoScheme {
  keygen(): [Key, Key[]] {
    return ["TODO", []];
  }

  sign(msg: string, private_key: Key): Signature {
    return "TODO";
  }

  combine(msg: string, partial_signatures: Signature[]): Signature | null {
    return "TODO";
  }

  verify(msg: string, signature: Signature, public_key: Key): boolean {
    return false; // TODO
  }
}
