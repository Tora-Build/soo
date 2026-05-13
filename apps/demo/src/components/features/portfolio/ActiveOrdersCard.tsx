import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import { useOrderStore, type ActiveOrder } from '../../../store/useOrderStore';
import { useOrderbookTrade } from '../../../hooks/useOrderbookTrade';
import { Clock, XCircle, TrendingUp, TrendingDown, ListX } from 'lucide-react';
import { formatCurrency } from '../../../utils/format';
import { formatDistanceToNow } from 'date-fns';
import { PortfolioCard } from './PortfolioCard';
import { useDemo } from '../../../lib/DemoContext';
import { fetchUserOpenOrders } from '../../../lib/chain-shim/orderbook-reads';

const OrderItem: React.FC<{ order: ActiveOrder }> = ({ order }) => {
    const { cancelOrder, isPending } = useOrderbookTrade(order.marketAddress);

    return (
        <div
            className="p-2.5 bg-raised border border-rule/50 hover:bg-raised hover:border-accent/40 transition-colors group"
            data-testid="portfolio-active-order-row"
            data-order-id={order.id}
        >
            <div className="flex justify-between items-start mb-1.5">
                <div className="min-w-0 flex-1">
                    <h4 className="font-bold text-xs text-ink truncate pr-2" title={order.marketName}>
                        {order.marketName}
                    </h4>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <p className="text-xs text-muted font-mono leading-none">
                            {formatDistanceToNow(order.timestamp, { addSuffix: true })}
                        </p>
                        {order.escrow && (
                            <span
                                className="text-[10px] font-mono uppercase tracking-[0.12em] text-accent"
                                data-testid="portfolio-order-escrow"
                            >
                                Escrow
                            </span>
                        )}
                    </div>
                </div>
                <button
                    onClick={() => cancelOrder(order.id)}
                    disabled={isPending}
                    className="p-1 hover:bg-raised text-muted hover:text-muted transition-colors disabled:opacity-50"
                    title="Cancel Order"
                >
                    <XCircle size={12} />
                </button>
            </div>

            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                    <div className={`p-1 rounded ${order.outcome === 0 ? 'bg-accent-muted text-ink' : 'bg-raised text-muted'}`}>
                        {order.outcome === 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                    </div>
                    <div>
                        <div className="font-mono text-xs text-ink uppercase tracking-[0.12em]">
                            {order.outcome === 0 ? 'YES' : 'NO'} @ {formatCurrency(order.price)}
                        </div>
                        <div className="text-xs text-muted font-mono leading-none">
                            Amt: {order.amount.toFixed(2)}
                        </div>
                    </div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-xs text-muted uppercase tracking-[0.12em] leading-none mb-0.5">Collat</div>
                    <div className="text-xs font-bold text-ink font-mono leading-none">
                        {formatCurrency(order.amount * (order.outcome === 0 ? order.price : (1 - order.price)))}
                    </div>
                </div>
            </div>
        </div>
    );
};

function shortMarket(ref: string): string {
    const stripped = ref.replace(/^sol:/, '');
    return `${stripped.slice(0, 6)}…${stripped.slice(-4)}`;
}

function orderToActiveOrder(marketRef: string, order: Awaited<ReturnType<typeof fetchUserOpenOrders>>[number]): ActiveOrder {
    const marketAddress = `0x${marketRef.replace(/^sol:/, '')}` as `0x${string}`;
    return {
        id: order.orderId.toString(),
        marketAddress,
        marketName: shortMarket(marketRef),
        outcome: order.side === 1 ? 0 : 1,
        price: order.tick / 1000,
        amount: Number(order.amount) / 1e18,
        timestamp: Date.now(),
        isBuy: !order.escrow,
        escrow: order.escrow,
    };
}

export const ActiveOrdersCard: React.FC<{ marketRef?: string | null }> = ({ marketRef }) => {
    const { activeOrders } = useOrderStore();
    const demo = useDemo();
    const { connection } = useConnection();
    const userBase58 = demo.userRef?.replace(/^sol:/, '');
    const chainOrders = useQuery({
        queryKey: ['portfolio-chain-orders', marketRef, userBase58],
        queryFn: async () => {
            if (!marketRef || !userBase58) return [];
            const orders = await fetchUserOpenOrders(
                connection as never,
                demo.adapter,
                marketRef,
                userBase58,
            );
            return orders.map((order) => orderToActiveOrder(marketRef, order));
        },
        enabled: !!marketRef && !!userBase58,
        refetchInterval: 15_000,
    });
    const orders = useMemo(() => {
        const byId = new Map<string, ActiveOrder>();
        for (const order of chainOrders.data ?? []) byId.set(order.id, order);
        for (const order of activeOrders) byId.set(order.id, order);
        return Array.from(byId.values());
    }, [activeOrders, chainOrders.data]);

    return (
        <PortfolioCard
            title="Limit Orders"
            icon={<Clock size={16} className="text-muted" />}
            variant="default"
            badge={
                <span className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                    {orders.length} open
                </span>
            }
            itemCount={orders.length}
            emptyState={
                <div className="py-6 text-center flex flex-col items-center justify-center opacity-40">
                    <ListX size={24} className="text-faint mb-1" />
                    <p className="text-xs font-mono">// no_active_orders</p>
                </div>
            }
        >
            {orders.map(order => <OrderItem key={order.id} order={order} />)}
        </PortfolioCard>
    );
};
