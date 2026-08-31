import { useTranslation } from "react-i18next";

import { useHasModeBanner } from "../../layout/ModeBanner";

/**
 * The Forge's own title — rendered only where the shell has not already
 * supplied one. On /forge the arcade banner reads "Turn a question into a
 * live arena", so printing "Create Market" underneath gave the page two
 * names and the document two <h1>s. Under /eastboard there is no banner,
 * and this is the only heading the page has.
 */
export const LaunchpadHeader = () => {
    const { t } = useTranslation();
    if (useHasModeBanner()) return null;
    return (
        <div className="space-y-1">
            <h1 className="text-lg font-bold text-ink">{t("launchpad.pageTitle")}</h1>
            <p className="text-sm text-muted">{t("launchpad.pageSubtitle")}</p>
        </div>
    );
};
