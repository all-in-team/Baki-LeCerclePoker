import dynamic from "next/dynamic";

const WalletCharts = dynamic(() => import("./WalletCharts"), { ssr: false });
export default WalletCharts;
