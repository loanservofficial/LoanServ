import type { Offer } from "./offers";

/** "9.99% – 16.5%", or "9.99% onwards" when the lender publishes no maximum. */
export function formatRoiRange(o: Pick<Offer, "roiFrom" | "roiTo">): string {
  return o.roiTo == null ? `${o.roiFrom}% onwards` : `${o.roiFrom}% – ${o.roiTo}%`;
}

/** A dash for fields the lender doesn't publish, so tables never show blanks. */
export function orDash(value: string): string {
  return value.trim() ? value : "—";
}
