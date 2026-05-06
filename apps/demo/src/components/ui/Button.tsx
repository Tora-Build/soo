import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "secondary"
    | "ghost"
    | "danger"
    /** @deprecated alias for `danger` — remove after sweep */
    | "destructive"
    /** @deprecated maps to `primary` — pick `primary` explicitly */
    | "success"
    /** @deprecated maps to `secondary` — pick `secondary` explicitly */
    | "info"
    /** @deprecated legacy skeuomorphic alias for `primary` */
    | "glow"
    /** @deprecated legacy accent-color alias for `secondary` */
    | "cyan";
  size?: "xs" | "sm" | "md" | "lg";
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      isLoading,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const variantClass: Record<string, string> = {
      primary: "btn btn-primary",
      secondary: "btn btn-secondary",
      ghost: "btn btn-ghost",
      danger: "btn btn-danger",
      destructive: "btn btn-danger", // deprecated
      success: "btn btn-primary", // deprecated
      info: "btn btn-secondary", // deprecated
      glow: "btn btn-primary", // deprecated
      cyan: "btn btn-secondary", // deprecated
    };
    const sizes: Record<string, string> = {
      xs: "px-2.5 py-1 text-xs",
      sm: "px-3.5 py-2 text-xs",
      md: "px-5 py-2.5 text-xs",
      lg: "px-7 py-3 text-xs",
    };
    return (
      <button
        ref={ref}
        className={cn(
          variantClass[variant] || "btn btn-secondary",
          sizes[size],
          className,
        )}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
