import React from 'react';
import { useOrderStore, ActiveOrder } from '../../../store/useOrderStore';
import { useOrderbookTrade } from '../../../hooks/useOrderbookTrade';
import { Clock, XCircle, TrendingUp, TrendingDown, ListX } from 'lucide-react';
import { formatCurrency } from '../../../utils/format';
import { formatDistanceToNow } from 'date-fns';
import { PortfolioCard } from './PortfolioCard';

const OrderItem: React.FC<{ order: ActiveOrder }> = ({ order }) => {
    const { cancelOrder, isPending } = useOrderbookTrade(order.marketAddress);

    return (
        <div className="p-2.5 bg-raised border border-rule/50 hover:bg-raised hover:border-accent/40 transition-colors group">
            <div className="flex justify-between items-start mb-1.5">
                <div className="min-w-0 flex-1">
                    <h4 className="font-bold text-xs text-ink truncate pr-2" title={order.marketName}>
                        {order.marketName}
                    </h4>
                    <p className="text-xs text-muted font-mono leading-none mt-0.5">
                        {formatDistanceToNow(order.timestamp, { addSuffix: true })}
                    </p>
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

export const ActiveOrdersCard: React.FC = () => {
    const { activeOrders } = useOrderStore();

    return (
        <PortfolioCard
            title="Limit Orders"
            icon={<Clock size={16} className="text-muted" />}
            variant="default"
            badge={
                <span className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                    {activeOrders.length} open
                </span>
            }
            itemCount={activeOrders.length}
            emptyState={
                <div className="py-6 text-center flex flex-col items-center justify-center opacity-40">
                    <ListX size={24} className="text-faint mb-1" />
                    <p className="text-xs font-mono">// no_active_orders</p>
                </div>
            }
        >
            {activeOrders.map(order => <OrderItem key={order.id} order={order} />)}
        </PortfolioCard>
    );
};
