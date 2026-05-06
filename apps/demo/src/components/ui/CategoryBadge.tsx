import {
  TrendingUp,
  Trophy,
  CloudSun,
  Users,
  BarChart3,
  Zap,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

const CATEGORY_CONFIG: Record<string, { label: string; icon: LucideIcon }> = {
  sports: { label: "Sports", icon: Trophy },
  weather: { label: "Weather", icon: CloudSun },
  tech: { label: "Tech", icon: Cpu },
  cultures: { label: "Culture", icon: Users },
  crypto: { label: "Crypto", icon: TrendingUp },
  politics: { label: "Politics", icon: BarChart3 },
  others: { label: "Other", icon: Zap },
};

interface CategoryBadgeProps {
  category: string;
  className?: string;
}

export const CategoryBadge = ({ category, className }: CategoryBadgeProps) => {
  const { t } = useTranslation();
  const config = CATEGORY_CONFIG[category] ?? CATEGORY_CONFIG.others;
  const Icon = config.icon;
  const labelKey =
    category === "cultures"
      ? "marketsPage.categories.culture"
      : category === "others"
        ? "marketsPage.categories.other"
        : `marketsPage.categories.${category}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted",
        className,
      )}
    >
      <Icon className="w-3 h-3" />
      {t(labelKey, { defaultValue: config.label })}
    </span>
  );
};

export { CATEGORY_CONFIG };
