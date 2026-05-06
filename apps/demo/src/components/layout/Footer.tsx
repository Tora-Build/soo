import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Twitter, Send } from 'lucide-react';
import { useIndexerStatus } from '../../hooks/useIndexerStatus';
import { useChainStatus } from '../../hooks/useChainStatus';
import deployments from '../../config/deployments.json';

export const Footer = () => {
  const { currentChainStatus, isLoading, error } = useIndexerStatus();
  const { rpcBlock, rpcConnected } = useChainStatus();
  const [showStatusHelp, setShowStatusHelp] = useState(false);

  const syncLag = rpcBlock && currentChainStatus
    ? rpcBlock - currentChainStatus.block.number
    : null;

  const isSynced = syncLag !== null && syncLag < 10;

  return (
    <footer className="border-t border-rule bg-canvas py-6 mt-auto">
      <div className="container mx-auto max-w-7xl px-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-faint uppercase tracking-[0.1em]">Sooth Protocol | {deployments.version}</span>

          {!isLoading && (
            <div className="flex items-center gap-3">
              <div
                className="flex items-center gap-1.5"
                title={rpcConnected ? "Direct RPC connection active" : "RPC disconnected"}
              >
                <div className={`w-1 h-1 ${rpcConnected ? 'bg-accent' : 'bg-faint'}`} />
                <span className="font-mono text-xs text-faint">
                  RPC
                </span>
              </div>

              <div className="w-px h-3 bg-rule" />

              <div
                className="flex items-center gap-1.5"
                title={
                  error
                    ? 'Ponder indexer is offline'
                    : isSynced
                      ? 'Indexer is synced with chain'
                      : syncLag && syncLag > 0
                        ? `Indexer is ${syncLag} blocks behind`
                        : 'Indexer status unknown'
                }
              >
                <div className={`w-1 h-1 ${error
                  ? 'bg-faint'
                  : isSynced
                    ? 'bg-accent'
                    : currentChainStatus
                      ? 'bg-accent'
                      : 'bg-faint'
                  }`} />
                <span className="font-mono text-xs text-faint">
                  {error
                    ? 'Indexer offline'
                    : currentChainStatus
                      ? isSynced
                        ? `Block ${currentChainStatus.block.number.toLocaleString()}`
                        : syncLag && syncLag > 0
                          ? `Block ${currentChainStatus.block.number.toLocaleString()} (-${syncLag})`
                          : `Block ${currentChainStatus.block.number.toLocaleString()}`
                      : 'Not indexed'}
                </span>
              </div>

              <div className="relative">
                <button
                  className="w-4 h-4 border border-rule text-faint hover:text-muted transition-colors duration-100 flex items-center justify-center font-mono text-[9px]"
                  onMouseEnter={() => setShowStatusHelp(true)}
                  onMouseLeave={() => setShowStatusHelp(false)}
                  aria-label="Status indicator help"
                >
                  ?
                </button>

                {showStatusHelp && (
                  <div className="absolute bottom-full right-0 mb-2 w-80 bg-tooltip border border-rule p-4 z-[9999]">
                    <h4 className="font-mono text-xs uppercase tracking-[0.1em] text-accent mb-2">Status Indicators</h4>
                    <div className="space-y-3 font-mono text-xs text-muted">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-1 h-1 bg-accent"></div>
                          <span className="text-ink">Indexer</span>
                          <span className="text-accent font-mono text-[9px] uppercase">CRITICAL</span>
                        </div>
                        <p className="text-faint ml-4">
                          Historical data for orderbook, trades, and market history.
                          <br />
                          <span className="text-faint">Without: No orderbook visible</span>
                        </p>
                      </div>

                      <div className="border-t border-rule pt-2">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-1 h-1 bg-accent"></div>
                          <span className="text-ink">RPC</span>
                          <span className="text-accent font-mono text-[9px] uppercase">IMPORTANT</span>
                        </div>
                        <p className="text-faint ml-4">
                          Direct blockchain connection for live balances and current state.
                          <br />
                          <span className="text-faint">Without: Stale wallet data</span>
                        </p>
                      </div>

                      <div className="border-t border-rule pt-2">
                        <p className="text-faint">
                          Online = Active | Offline = Unavailable
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <a href="https://t.me/soothprotocol" target="_blank" rel="noopener noreferrer" className="text-faint hover:text-ink transition-colors duration-100 flex items-center p-1" title="Telegram">
            <Send size={14} />
          </a>
          <a href="https://x.com/SoothProtocol" target="_blank" rel="noopener noreferrer" className="text-faint hover:text-ink transition-colors duration-100 flex items-center p-1" title="X (Twitter)">
            <Twitter size={14} />
          </a>
        </div>
      </div>
    </footer>
  );
};
