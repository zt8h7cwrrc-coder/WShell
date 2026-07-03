declare module "sodium-native" {
  export const crypto_secretbox_KEYBYTES: number;
  export const crypto_secretbox_NONCEBYTES: number;
  export const crypto_secretbox_MACBYTES: number;
  export const crypto_kdf_KEYBYTES: number;
  export const crypto_generichash_BYTES: number;
  export const crypto_generichash_BYTES_MIN: number;
  export const crypto_generichash_BYTES_MAX: number;

  export function randombytes_buf(buf: Buffer): void;
  export function randombytes_buf(buf: Buffer, length: number): void;
  export function randombytes_random(): number;

  export function crypto_kdf_keygen(key: Buffer): void;
  export function crypto_kdf_derive_from_key(
    subkey: Buffer,
    subkey_id: number,
    context: Buffer,
    key: Buffer,
  ): void;

  export function crypto_generichash(output: Buffer, input: Buffer, key?: Buffer): void;
  export function crypto_generichash(
    output: Buffer,
    input_length: number | null,
    input: Buffer,
    key?: Buffer,
  ): void;

  export function crypto_secretbox_easy(
    ciphertext: Buffer,
    message: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): void;
  export function crypto_secretbox_open_easy(
    message: Buffer,
    ciphertext: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): boolean;

  // The package's default export exposes the same surface as the named
  // exports. We mirror the named exports here as a namespace so that
  // `import sodium from "sodium-native"` keeps full typing.
  const sodium: {
    crypto_secretbox_KEYBYTES: typeof crypto_secretbox_KEYBYTES;
    crypto_secretbox_NONCEBYTES: typeof crypto_secretbox_NONCEBYTES;
    crypto_secretbox_MACBYTES: typeof crypto_secretbox_MACBYTES;
    crypto_kdf_KEYBYTES: typeof crypto_kdf_KEYBYTES;
    crypto_generichash_BYTES: typeof crypto_generichash_BYTES;
    crypto_generichash_BYTES_MIN: typeof crypto_generichash_BYTES_MIN;
    crypto_generichash_BYTES_MAX: typeof crypto_generichash_BYTES_MAX;
    randombytes_buf: typeof randombytes_buf;
    crypto_kdf_keygen: typeof crypto_kdf_keygen;
    crypto_kdf_derive_from_key: typeof crypto_kdf_derive_from_key;
    crypto_generichash: typeof crypto_generichash;
    crypto_secretbox_easy: typeof crypto_secretbox_easy;
    crypto_secretbox_open_easy: typeof crypto_secretbox_open_easy;
  };
  export default sodium;
}
