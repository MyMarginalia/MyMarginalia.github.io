import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  IMPORTANCES,
  IMPORTANCE_CLASS,
  IMPORTANCE_DOT,
  IMPORTANCE_LABEL,
  STATUSES,
  STATUS_CLASS,
  STATUS_DOT,
  STATUS_LABEL,
  type PaperImportance,
  type PaperStatus,
} from "@/lib/paper-types";

export function StatusPill({ status }: { status: PaperStatus }) {
  return (
    <Badge variant="outline" className={cn("font-normal", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function ImportancePill({ importance }: { importance: PaperImportance }) {
  return (
    <Badge variant="outline" className={cn("font-normal", IMPORTANCE_CLASS[importance])}>
      {IMPORTANCE_LABEL[importance]}
    </Badge>
  );
}

export function StatusSelect({
  value,
  onChange,
  className,
}: {
  value: PaperStatus;
  onChange: (v: PaperStatus) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PaperStatus)}>
      <SelectTrigger
        aria-label="Status"
        className={cn("h-7 w-auto gap-1.5 px-2 text-xs", STATUS_CLASS[value], className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            <span className={cn("mr-2 inline-block h-2 w-2 rounded-full", STATUS_DOT[s])} />
            {STATUS_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ImportanceSelect({
  value,
  onChange,
  className,
}: {
  value: PaperImportance;
  onChange: (v: PaperImportance) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PaperImportance)}>
      <SelectTrigger
        aria-label="Importance"
        className={cn("h-7 w-auto gap-1.5 px-2 text-xs", IMPORTANCE_CLASS[value], className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {IMPORTANCES.map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            <span className={cn("mr-2 inline-block h-2 w-2 rounded-full", IMPORTANCE_DOT[s])} />
            {IMPORTANCE_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}