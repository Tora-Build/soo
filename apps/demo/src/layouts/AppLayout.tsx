import { Outlet } from 'react-router-dom';
import { Navbar } from '../components/layout/Navbar';
import { Footer } from '../components/layout/Footer';
import { ActivityListener } from '../components/features/ActivityListener';

import { useAccentStore } from '../store/useAccentStore';
import { useEffect } from 'react';

export const AppLayout = () => {
  const { accent } = useAccentStore();

  // Apply accent color CSS variables on mount and when accent changes
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-muted', accent + '0F');
  }, [accent]);

  return (
    <div className="min-h-dvh flex flex-col pb-safe text-ink">
      <Navbar />
      <ActivityListener />

      <main className="flex-1 container mx-auto max-w-7xl px-4 py-8">
        <Outlet />
      </main>

      <Footer />
    </div>
  );
};
