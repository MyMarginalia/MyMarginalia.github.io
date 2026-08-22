import type { LibraryItem, PaperInput, PaperStatus, CatalogPaper } from "@/lib/paper-types";
import * as db from "@/lib/db";
import { lookupMetadata } from "@/lib/metadata";

export async function listLibrary(): Promise<LibraryItem[]> {
  return await db.listLibrary();
}

export async function getLibraryItem(input: { paperId: string }): Promise<LibraryItem | null> {
  return await db.getLibraryItem(input.paperId);
}

export async function addPaper(input: PaperInput): Promise<{ paperId: string }> {
  return await db.addPaper(input);
}

export async function updateUserPaper(input: {
  paperId: string;
  values: Partial<Omit<LibraryItem, "paper_id" | "paper" | "created_at">>;
}): Promise<{ ok: boolean }> {
  return await db.updateUserPaper(input.paperId, input.values);
}

export async function updatePaperMetadata(input: {
  paperId: string;
  values: Partial<CatalogPaper>;
}): Promise<{ ok: boolean; paperId: string }> {
  return await db.updatePaperMetadata(input.paperId, input.values);
}

export async function removeFromLibrary(input: { paperId: string }): Promise<{ ok: boolean }> {
  return await db.removeFromLibrary(input.paperId);
}

export async function bulkSetStatus(input: {
  ids: string[];
  status: PaperStatus;
}): Promise<{ ok: boolean }> {
  return await db.bulkSetStatus(input.ids, input.status);
}

export async function lookupPaperMetadata(input: { query: string }) {
  return await lookupMetadata(input.query);
}
