/**
 * Polymarket taker fee in USDC (docs.polymarket.com/trading/fees):
 * shares * rate * p * (1 - p). Zero at p = 0 or 1, so resolution payouts are
 * fee-free; makers never pay, and a copy always takes.
 */
export function takerFeeCost(rate: number | undefined, price: number, shares: number): number {
  if (!rate || !(price > 0 && price < 1)) return 0;
  return shares * rate * price * (1 - price);
}
