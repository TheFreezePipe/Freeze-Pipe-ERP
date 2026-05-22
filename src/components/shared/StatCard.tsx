import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  iconColor?: string;
  trend?: { value: number; label: string };
  /** Render as inactive/coming-soon: muted colors, no value emphasis,
   *  card itself is dimmed. Use when the metric exists structurally but
   *  the underlying data feed isn't wired yet (e.g. Homebase labor hours). */
  disabled?: boolean;
}

export function StatCard({ title, value, subtitle, icon: Icon, iconColor = "text-primary", trend, disabled }: StatCardProps) {
  return (
    <Card className={cn(disabled && "opacity-50 bg-muted/20")} title={disabled ? "This metric is awaiting a data source — not yet operational" : undefined}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className={cn("text-2xl font-bold", disabled && "text-muted-foreground")}>{value}</p>
            {subtitle && (
              <p className={cn("text-xs text-muted-foreground", disabled && "italic")}>
                {subtitle}
              </p>
            )}
            {trend && (
              <p className={cn("text-xs font-medium", trend.value >= 0 ? "text-green-400" : "text-red-400")}>
                {trend.value >= 0 ? "+" : ""}{trend.value}% {trend.label}
              </p>
            )}
          </div>
          <div className={cn("rounded-md bg-muted p-2", disabled ? "text-muted-foreground/40" : iconColor)}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
