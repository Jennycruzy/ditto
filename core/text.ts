export type Quoted = { text: string; untrusted: true };
export function quote(value: string): Quoted {
  // Remove controls and directional/formatting characters before quoting as data.
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  return { text: JSON.stringify(Array.from(clean).slice(0, 40).join("")), untrusted: true };
}

export function atomicAmount(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid decimals");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 512) throw new Error("Invalid amount");
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Too many decimal places");
  return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
}
export function displayAmount(atomic: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(atomic) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid amount");
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}
