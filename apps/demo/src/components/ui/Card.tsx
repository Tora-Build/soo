import React from 'react';
import { cn } from '../../lib/utils';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'premium' | 'interactive' | 'inset';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const base = variant === 'inset' ? 'panel-inset' : 'panel';
    return <div ref={ref} className={cn(base, 'p-5', className)} {...props} />;
  }
);
Card.displayName = 'Card';
