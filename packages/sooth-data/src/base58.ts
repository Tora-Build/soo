const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_INDEX = new Map(
  Array.from(ALPHABET).map((char, index) => [char, index]),
);

export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array();

  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") {
    zeros += 1;
  }
  if (zeros === input.length) {
    return new Uint8Array(zeros);
  }

  const bytes: number[] = [0];
  for (const char of input.slice(zeros)) {
    const value = ALPHABET_INDEX.get(char);
    if (value === undefined) {
      throw new Error(`invalid base58 character: ${char}`);
    }

    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      const next = bytes[i]! * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  return new Uint8Array([...Array(zeros).fill(0), ...bytes.reverse()]);
}

export function encodeBase58(input: Uint8Array): string {
  if (input.length === 0) return "";

  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) {
    zeros += 1;
  }
  if (zeros === input.length) {
    return "1".repeat(zeros);
  }

  const digits: number[] = [0];
  for (const byte of input.slice(zeros)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const next = digits[i]! * 256 + carry;
      digits[i] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  return `${"1".repeat(zeros)}${digits
    .reverse()
    .map((digit) => ALPHABET[digit]!)
    .join("")}`;
}
