import type { Hash } from "./crypto_types";

/**
 * A cryptographic hash function (a message digest).
 *
 * @param msg The message to hash.
 * @returns A fixed-length hash.
 */
export function hash(msg: string): Hash {
  return "Hashed:" + msg; // TODO
}
