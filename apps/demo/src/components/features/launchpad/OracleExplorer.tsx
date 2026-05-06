/**
 * OracleExplorer — Embeds the ZK Oracle test UI for market discovery
 *
 * Wraps the deployed zkoracle test UI in an iframe. The test UI already handles
 * all 321+ adapters, intent parsing, live data fetching, and result display.
 * When zkTLS integration ships, this same UI will support verified mode.
 */

// Matches PolymarketSelectData shape for reuse in Launchpad.tsx handler
export interface OracleSelectData {
  question: string;
  category: string;
  expiration: string | null;
  daysUntilExpiration: number | null;
  liquidity: number;
  volume24h: number;
  yesPrice: number;
  polymarketUrl: string;
  description: string | null;
  oracleAdapter?: string;
  oracleParams?: Record<string, unknown>;
  oracleComparison?: string;
  oracleThreshold?: string;
}

const ORACLE_URL = '/zk-oracle-book.html';

interface OracleExplorerProps {
  onSelectMarket?: (data: OracleSelectData) => void;
}

export const OracleExplorer: React.FC<OracleExplorerProps> = () => {
  return (
    <div className="h-full flex flex-col">
      <iframe
        src={ORACLE_URL}
        className="flex-1 w-full border-0 h-full"
        allow="clipboard-read; clipboard-write"
        title="ZK Oracle Book"
      />
    </div>
  );
};
