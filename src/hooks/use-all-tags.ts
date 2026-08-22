import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listLibrary } from "@/lib/papers";

/** Every tag already used across the user's local library. */
export function useAllTags() {
  const { data: items = [] } = useQuery({ queryKey: ["library"], queryFn: () => listLibrary() });
  return useMemo(() => Array.from(new Set(items.flatMap((i) => i.tags))).sort(), [items]);
}