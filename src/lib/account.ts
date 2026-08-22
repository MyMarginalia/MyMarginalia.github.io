import * as db from "@/lib/db";
export type { ProfileData, FullBackup } from "@/lib/db";
export { exportBackupJson, importBackupJson, getAccountStats } from "@/lib/db";

export async function getMyProfile() {
  return await db.getProfile();
}

export async function updateMyProfile(input: { display_name?: string | null }) {
  return await db.updateProfile(input);
}

export async function deleteMyAccount() {
  await db.clearEntireLibrary();
  return { ok: true };
}
