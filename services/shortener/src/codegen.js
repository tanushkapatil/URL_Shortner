// Turns a numeric ID (from a Postgres sequence) into a 7-character base62 short code.
//
// Why this is safe with many replicas: the sequence is incremented atomically by
// Postgres, so no two replicas can ever receive the same ID. Multiplying by a number
// that is coprime with 62^7 is a bijection on [0, 62^7), so distinct IDs always map
// to distinct codes, while consecutive IDs produce codes that look random
// (1000 -> "82xC4OB", 1001 -> "9D9XpQB", ...) and cannot be guessed by counting.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LENGTH = 7;
const SPACE = 62n ** BigInt(LENGTH); // ~3.5 trillion codes
const MULTIPLIER = 2147483647n; // prime, not 2 or 31 -> coprime with 62^7

function encode(id) {
  let n = (BigInt(id) * MULTIPLIER) % SPACE;
  let code = '';
  for (let i = 0; i < LENGTH; i++) {
    code += ALPHABET[Number(n % 62n)]; // least-significant digit first
    n /= 62n;
  }
  return code;
}

module.exports = { encode };
