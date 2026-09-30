// Builtins loaded on first use. node:crypto alone costs ~18 ms to load, which matters for
// hooks and `kerb check`, and most invocations never hash anything.
import { createRequire } from 'node:module';

// In the standalone binary (a CommonJS bundle) `require` already exists and loads builtins.
const load = typeof globalThis.require === 'function' ? globalThis.require : createRequire(import.meta.url);
let cryptoMod = null;
let cpMod = null;

/** @returns {typeof import('node:crypto')} */
export function crypto() {
  if (!cryptoMod) cryptoMod = load('node:crypto');
  return cryptoMod;
}

/** @returns {typeof import('node:child_process')} */
export function childProcess() {
  if (!cpMod) cpMod = load('node:child_process');
  return cpMod;
}

/** Is this the standalone (single-executable) build? */
export function isSea() {
  try { return load('node:sea').isSea(); } catch { return false; }
}
