import type { MachineReviewCard } from "@mex/hub-contracts/machine";
import type { HomeOverview } from "./types";

export type ReviewRow = Pick<MachineReviewCard, "key" | "repoId" | "claim" | "createdAt" | "kind" | "checkedByModel" | "contradiction">;

const day = 86_400_000;
const number = new Intl.NumberFormat();
export const repoPrefix = (repoId?: string) => repoId ? "/repos/" + encodeURIComponent(repoId) : "";

export function reviewHref(repoId?: string, cardKey?: string, search = "") {
  return repoPrefix(repoId) + "/review" + (cardKey ? "/" + encodeURIComponent(cardKey) : "") + search;
}

export function waitingAge(at: string, now: number) {
  const days = Math.max(0, Math.floor((now - Date.parse(at)) / day));
  return days ? dayLabel(days) : "less than a day";
}

export function remainingAge(at: string, now: number) {
  const days = Math.max(0, Math.ceil((Date.parse(at) - now) / day));
  return days ? dayLabel(days) : "less than a day";
}

function dayLabel(days: number) {
  return number.format(days) + (days === 1 ? " day" : " days");
}

export function orderReviewRows(rows: readonly ReviewRow[]) {
  return [...rows].sort((a, b) => Number(Boolean(b.contradiction)) - Number(Boolean(a.contradiction))
    || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.key.localeCompare(b.key));
}

export function reviewCount(overview?: HomeOverview, repoId?: string) {
  const counts = overview?.needsCount;
  return repoId ? counts?.[repoId]?.count ?? 0 : Object.values(counts ?? {}).reduce((total, { count }) => total + count, 0);
}
