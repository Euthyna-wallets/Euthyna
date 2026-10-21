export function formatToken(amount: string | bigint | null | undefined, decimals = 6, symbol = "TestUSDC", precision = 2): string {
  if (amount === null || amount === undefined) return "—";
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, precision);
  return `${whole}.${fraction} ${symbol}`;
}

export function formatEth(wei: string | bigint | null | undefined, precision = 4): string {
  if (wei === null || wei === undefined) return "—";
  const value = BigInt(wei);
  const base = 10n ** 18n;
  const whole = value / base;
  const fraction = (value % base).toString().padStart(18, "0").slice(0, precision);
  return `${whole}.${fraction} ETH`;
}

export function formatNonce(nonce: number | string | null | undefined): string {
  if (nonce === null || nonce === undefined) return "—";
  return String(nonce);
}

export function formatBytesAddress(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte))) {
    return `0x${value.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("")}`;
  }
  return "—";
}
