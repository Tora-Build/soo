import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EastboardHeader } from "../components/eastboard/EastboardHeader";

export function EastboardLayout() {
  const { t } = useTranslation();

  return (
    <div className="min-h-[100dvh] bg-canvas text-ink">
      <EastboardHeader />
      <div className="border-b border-rule bg-warn-soft px-4 py-2 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-warn">
        {t("eastboard.shell.testnetBanner")}
      </div>
      <main className="mx-auto w-full max-w-[1480px] px-4 py-8 md:px-7 lg:px-10 lg:py-12">
        <Outlet />
      </main>
      <footer className="mx-auto flex w-full max-w-[1480px] flex-col gap-2 border-t border-rule px-4 py-7 font-mono text-[10px] uppercase tracking-[0.12em] text-faint md:flex-row md:items-center md:justify-between md:px-7 lg:px-10">
        <span>EastBoard / Soo Protocol</span>
        <span>{t("eastboard.shell.networkFooter")}</span>
      </footer>
    </div>
  );
}
