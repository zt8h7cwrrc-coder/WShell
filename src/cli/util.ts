// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/** Shared CLI helpers. */

/** Print an error to stderr and exit with code 1. */
export function fatal(msg: string): never {
  console.error(`wshell: ${msg}`);
  process.exit(1);
}
