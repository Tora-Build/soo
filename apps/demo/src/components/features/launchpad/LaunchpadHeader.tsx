import { useTranslation } from "react-i18next";

export const LaunchpadHeader = () => {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <h1 className="text-lg font-bold text-ink">{t("launchpad.pageTitle")}</h1>
            <p className="text-sm text-muted">{t("launchpad.pageSubtitle")}</p>
        </div>
    );
};
