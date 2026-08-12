// polyfills.js
// MUST be required before @whiskeysockets/baileys.
//
// Baileys 6.7 reads `globalThis.crypto.subtle` at module load. Web Crypto is
// only exposed globally from Node 19 onward, so on Node 18 the very first
// require of Baileys throws:
//
//   TypeError: Cannot destructure property 'subtle' of 'globalThis.crypto'
//
// The process dies before Express ever listens, which looks from the outside
// exactly like "the QR never generates" — there is no server to serve one.
// Node 18 is still an active LTS, so rather than force an upgrade we hand it
// the same implementation newer Node exposes by default.
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

module.exports = {};
