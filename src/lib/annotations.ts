import {
  ANNOTATION_COLORS,
  type Annotation,
  type AnnotationColor,
  type Rect,
} from "@/lib/paper-types";
import * as db from "@/lib/db";

export { ANNOTATION_COLORS, type Annotation, type AnnotationColor, type Rect };

export async function listAnnotations(input: { paperId: string }): Promise<Annotation[]> {
  return await db.listAnnotations(input.paperId);
}

export async function createAnnotation(input: {
  paperId: string;
  page: number;
  kind: "highlight" | "note";
  quote?: string | null;
  comment?: string | null;
  color?: AnnotationColor;
  rects: Rect[];
}): Promise<{ id: string }> {
  return await db.createAnnotation(input);
}

export async function updateAnnotation(input: {
  id: string;
  comment?: string | null;
  color?: AnnotationColor;
}): Promise<{ ok: boolean }> {
  const { id, ...patch } = input;
  return await db.updateAnnotation(id, patch);
}

export async function deleteAnnotation(input: { id: string }): Promise<{ ok: boolean }> {
  return await db.deleteAnnotation(input.id);
}
