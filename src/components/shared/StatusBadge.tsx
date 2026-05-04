import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  label: string;
  color?: string;
  bgColor?: string;
}

export function StatusBadge({ label, color = "text-foreground", bgColor = "bg-muted" }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn("font-medium border-0", color, bgColor)}>
      {label}
    </Badge>
  );
}
