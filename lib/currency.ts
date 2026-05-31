import { getExchangeRate } from "./queries";

export function convertCnyToUsdt(cny: number, rate?: number): number {
  const r = rate ?? getExchangeRate("CNY");
  return r === 0 ? 0 : cny * r;
}

export function getCnyRate(): number {
  return getExchangeRate("CNY");
}
