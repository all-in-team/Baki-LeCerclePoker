"use client";

import dynamic from "next/dynamic";

const AccountingCharts = dynamic(() => import("./AccountingCharts"), { ssr: false });

interface MonthRow { month: string; gross: number; player_cuts: number; net: number }
interface WeekRow { week: string; gross: number; player_cuts: number; net: number }
interface AppRow { name: string; net: number }
interface PlayerRow { name: string; net: number }

export default function ChartsWrapper(props: { byMonth: MonthRow[]; byWeek: WeekRow[]; byApp: AppRow[]; byPlayer: PlayerRow[] }) {
  return <AccountingCharts {...props} />;
}
