import React, { useState, useMemo } from 'react';
import { Card } from '../../ui/Card';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../lib/utils';

type CardVariant = 'cyan' | 'emerald' | 'indigo' | 'default';

const variantStyles: Record<CardVariant, { card: string; header: string; title: string; button: string }> = {
    cyan: {
        card: 'border-accent/20 bg-accent/30',
        header: 'bg-accent/40',
        title: 'text-accent',
        button: 'border-accent/10 hover:bg-accent/30',
    },
    emerald: {
        card: 'border-accent bg-accent/30',
        header: 'bg-accent/40',
        title: 'text-ink',
        button: 'border-accent hover:bg-accent/30',
    },
    indigo: {
        card: 'border-rule bg-raised',
        header: 'bg-raised/30',
        title: 'text-muted',
        button: 'border-rule/50 hover:bg-raised/30',
    },
    default: {
        card: 'border-rule bg-raised',
        header: 'bg-raised/30',
        title: 'text-ink',
        button: 'border-rule/50 hover:bg-raised/30',
    },
};

interface PortfolioCardProps {
    title: string;
    icon: React.ReactNode;
    badge?: React.ReactNode;
    children: React.ReactNode;
    itemCount: number;
    isLoading?: boolean;
    emptyState?: React.ReactNode;
    maxVisibleItems?: number;
    foldable?: boolean;
    variant?: CardVariant;
    className?: string;
}

export const PortfolioCard: React.FC<PortfolioCardProps> = ({
    title,
    icon,
    badge,
    children,
    itemCount,
    isLoading,
    emptyState,
    maxVisibleItems = 3,
    foldable = true,
    variant = 'default',
    className
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const styles = variantStyles[variant];

    const childArray = useMemo(() => React.Children.toArray(children), [children]);
    const hasMore = foldable && itemCount > maxVisibleItems && childArray.length > 1;

    const visibleChildren = useMemo(() => {
        if (!foldable || isExpanded || childArray.length <= 1) {
            return children;
        }
        return childArray.slice(0, maxVisibleItems);
    }, [foldable, isExpanded, childArray, children, maxVisibleItems]);

    return (
        <Card className={cn("flex flex-col overflow-hidden", styles.card, className)}>
            <div className={cn("mx-1.5 mt-1.5 px-2.5 py-1.5 flex items-center justify-between", styles.header)}>
                <div className="flex items-center gap-1.5">
                    {icon}
                    <h3 className={cn("font-mono text-xs uppercase tracking-[0.12em]", styles.title)}>{title}</h3>
                </div>
                {badge && <div>{badge}</div>}
            </div>

            <div className="p-2 flex-1">
                {isLoading ? (
                    <div className="py-4 text-center text-muted font-mono text-xs">// loading...</div>
                ) : itemCount === 0 ? (
                    emptyState
                ) : (
                    <div className="space-y-1.5">
                        {visibleChildren}
                    </div>
                )}
            </div>

            {hasMore && !isLoading && itemCount > 0 && (
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className={cn("w-full py-1 border-t font-mono text-xs text-muted hover:text-ink transition-all flex items-center justify-center gap-1.5 uppercase tracking-[0.12em]", styles.button)}
                >
                    {isExpanded ? (
                        <>Collapse <ChevronUp size={9} /></>
                    ) : (
                        <>See All ({itemCount}) <ChevronDown size={9} /></>
                    )}
                </button>
            )}
        </Card>
    );
};
