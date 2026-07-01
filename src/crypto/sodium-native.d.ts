declare module "sodium-native" {
  export const crypto_secretbox_KEYBYTES: number;
  export const crypto_secretbox_NONCEBYTES: number;
  export const crypto_secretbox_MACBYTES: number;
  export const crypto_kdf_KEYBYTES: number;
  export const crypto_generichash_BYTES: number;

  export function randombytes_buf(buf: Buffer): void;
  export function crypto_kdf_keygen(key: Buffer): void;
  export function crypto_kdf_derive_from_key(
    subkey: Buffer,
    subkey_id: number,
    context: Buffer,
    key: Buffer,
  ): void;
  export function crypto_generichash(
    output: Buffer,
    input: Buffer,
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
}
