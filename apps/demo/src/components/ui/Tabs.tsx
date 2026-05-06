import React, { createContext, useContext } from 'react';
import { cn } from '../../lib/utils';

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

const TabsContext = createContext<{ value: string; onValueChange: (v: string) => void } | null>(null);

export const Tabs: React.FC<TabsProps> = ({ value, onValueChange, children, className }) => (
  <TabsContext.Provider value={{ value, onValueChange }}>
    <div className={cn('w-full', className)}>{children}</div>
  </TabsContext.Provider>
);

export const TabsList: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn('flex items-center gap-0 border-b border-[#2a2a28]', className)}>
    {children}
  </div>
);

export const TabsTrigger: React.FC<{ value: string; children: React.ReactNode; className?: string }> = ({ value, children, className }) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsTrigger must be used within Tabs');

  const isActive = context.value === value;

  return (
    <button
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap px-4 py-2.5 font-mono text-xs uppercase tracking-[0.12em] transition-colors border-b-2 -mb-px',
        isActive
          ? 'text-[#e8e5e0] border-accent'
          : 'text-[#706b63] hover:text-[#e8e5e0] border-transparent',
        className
      )}
      onClick={() => context.onValueChange(value)}
    >
      {children}
    </button>
  );
};

export const TabsContent: React.FC<{ value: string; children: React.ReactNode; className?: string }> = ({ value, children, className }) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsContent must be used within Tabs');

  if (context.value !== value) return null;

  return (
    <div className={cn('mt-4', className)}>
      {children}
    </div>
  );
};
