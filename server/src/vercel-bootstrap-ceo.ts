// First-admin bootstrap for Vercel deployments (served by scripts/vercel/handler.ts). Authenticated public
// instances only accept the high-entropy bootstrap invite path (see
// doc/DEPLOYMENT-MODES.md §8), and on Vercel the operator has no shell next to
// the server to run `paperclipai auth bootstrap-ceo`. This mirrors that
// command behind PAPERCLIP_BOOTSTRAP_SECRET and refuses once an admin exists.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";

const INVITE_EXPIRY_HOURS = 24;

export type BootstrapCeoResult =
  | { status: "created"; inviteUrl: string; expiresAt: string }
  | { status: "admin_exists" };

export async function createBootstrapCeoInvite(databaseUrl: string, baseUrl: string): Promise<BootstrapCeoResult> {
  const db = createDb(databaseUrl);
  try {
    const admins = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .limit(1);
    if (admins.length > 0) return { status: "admin_exists" };

    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      );

    const token = `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
    const [created] = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        allowedJoinTypes: "human",
        expiresAt: new Date(now.getTime() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning();
    return {
      status: "created",
      inviteUrl: `${baseUrl.replace(/\/+$/, "")}/invite/${token}`,
      expiresAt: created.expiresAt.toISOString(),
    };
  } finally {
    const client = (db as { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } }).$client;
    await client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
