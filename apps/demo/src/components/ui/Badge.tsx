import React from "react";
import { cn } from "../../lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?:
    | "default"
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "outline"
    | "live"
    | "secondary"
    /** @deprecated alias for `danger` */
    | "destructive"
    /** @deprecated renders as `info` — prefer explicit `info` */
    | "indigo";
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = "default",
  children,
  ...props
}) => {
  const variantClass: Record<string, string> = {
    default: "badge",
    outline: "badge",
    secondary: "badge",
    success: "badge badge-success",
    warning: "badge badge-warning",
    danger: "badge badge-danger",
    info: "badge badge-info",
    live: "badge badge-live",
    destructive: "badge badge-danger", // deprecated alias
    indigo: "badge badge-info", // deprecated alias
  };
  return (
    <span
      className={cn(variantClass[variant] || "badge", className)}
      {...props}
    >
      {children}
    </span>
  );
};
