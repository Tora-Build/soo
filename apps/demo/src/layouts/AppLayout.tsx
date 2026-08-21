// The arcade shell.
//
// Arena is a game, so its chrome is a game's chrome: an ambient field of
// blurred orbs and film grain behind everything, the dock pinned left, and
// content offset to clear it. Without the offset the dock overlays the deck
// on any viewport narrower than ~1600px.

import { Outlet } from 'react-router-dom';
import { ArenaDock } from '../components/layout/ArenaDock';
import { ModeBanner } from '../components/layout/ModeBanner';
import { ArenaPlayerProvider } from '../features/arena/ArenaPlayerProvider';
import { Navbar } from '../components/layout/Navbar';
import { Footer } from '../components/layout/Footer';

import { useAccentStore } from '../store/useAccentStore';
import { SEASON } from '../features/arena/season';
import { useEffect } from 'react';

export const AppLayout = () => {
  const { accent } = useAccentStore();

  // Apply accent color CSS variables on mount and when accent changes
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-muted', accent + '0F');
    // The dock watermark reads this — CSS content cannot import SEASON.
    document.documentElement.style.setProperty(
      '--season-tag',
      JSON.stringify(`SOO / ${SEASON.id}`),
    );
  }, [accent]);

  return (
    <ArenaPlayerProvider>
      <div className="app-shell min-h-dvh flex flex-col pb-24 text-ink lg:pb-0">
        <div className="arena-ambient" aria-hidden="true">
          <span className="arena-orb arena-orb-one" />
          <span className="arena-orb arena-orb-two" />
          <span className="arena-orb arena-orb-three" />
          <span className="arcade-noise" />
        </div>
        <Navbar />
        <ArenaDock />

        <main className="relative flex-1 px-4 py-6 md:px-6 md:py-8 lg:ml-[92px] lg:px-8">
          <ModeBanner />
          <Outlet />
        </main>

        <div className="lg:ml-[92px]">
          <Footer />
        </div>
      </div>
    </ArenaPlayerProvider>
  );
};
