const Q96 = 1n << 96n, Q128 = 1n << 128n;
function sqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("Invalid square root");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const next = (x + n / x) >> 1n; if (next >= x) return x; x = next; }
}
// Fixed-point exponentiation from the price definition; no floating-point token math.
export function sqrtAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new Error("Invalid tick");
  let base = sqrt(Q128 * Q128 * 10001n / 10000n), result = Q128, exponent = Math.abs(tick);
  while (exponent) { if (exponent % 2) result = result * base / Q128; base = base * base / Q128; exponent = Math.floor(exponent / 2); }
  if (tick < 0) result = Q128 * Q128 / result;
  return (result + (1n << 32n) - 1n) >> 32n;
}
export function centredRange(currentTick: number, halfWidth: number, spacing: number) {
  if (![currentTick, halfWidth, spacing].every(Number.isInteger) || spacing <= 0 || halfWidth < spacing || halfWidth > 887272 || Math.abs(currentTick) > 887272) throw new Error("Invalid range");
  const lower = Math.max(Math.ceil(-887272 / spacing) * spacing, Math.floor((currentTick - halfWidth) / spacing) * spacing);
  const upper = Math.min(Math.floor(887272 / spacing) * spacing, Math.ceil((currentTick + halfWidth) / spacing) * spacing);
  if (lower >= currentTick || upper <= currentTick) throw new Error("Invalid range");
  return { lower, upper };
}
export function liquidityAmounts(price: bigint, lower: number, upper: number, available0: bigint, available1: bigint) {
  const a = sqrtAtTick(lower), b = sqrtAtTick(upper);
  if (available0 < 0n || available1 < 0n || price <= a || price >= b || a >= b) throw new Error("Invalid liquidity inputs");
  const l0 = available0 * price * b / Q96 / (b - price), l1 = available1 * Q96 / (price - a);
  const liquidity = l0 < l1 ? l0 : l1;
  const amount0 = liquidity * (b - price) * Q96 / b / price;
  const amount1 = liquidity * (price - a) / Q96;
  return { liquidity, amount0, amount1 };
}
export function spotOut(amount: bigint, price: bigint, token0In: boolean) {
  return token0In ? amount * price * price / (Q96 * Q96) : amount * Q96 * Q96 / (price * price);
}
export function amountsForLiquidity(price: bigint, lower: number, upper: number, liquidity: bigint) {
  const a = sqrtAtTick(lower), b = sqrtAtTick(upper);
  if (a >= b || price <= 0n || liquidity < 0n) throw new Error("Invalid liquidity inputs");
  if (price <= a) return { amount0: liquidity * (b - a) * Q96 / b / a, amount1: 0n };
  if (price >= b) return { amount0: 0n, amount1: liquidity * (b - a) / Q96 };
  return { amount0: liquidity * (b - price) * Q96 / b / price, amount1: liquidity * (price - a) / Q96 };
}
