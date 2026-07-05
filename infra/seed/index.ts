/**
 * Seed dev fixtures: the Flare Fitness tenant with canonical modules, sample entries,
 * and an API key.
 *
 * The `flare-fitness` tenant is seeded from the static snapshot at `api/_fixtures.ts`
 * so local Postgres ends up with the same content that the Vercel demo serves.
 *
 * Run: `pnpm seed`
 */
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { MODULES, ENTRIES_BY_SLUG } from "../../api/_fixtures";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL! } },
});

type EntryStatus = "draft" | "scheduled" | "active" | "expired" | "archived";

async function upsertTenantUsers(tenantId: string) {
  const editor = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: "bayan@example.com" } },
    create: {
      tenantId,
      email: "bayan@example.com",
      name: "Bayan (Editor)",
      role: "CLIENT_EDITOR",
      passwordHash: await bcrypt.hash("password1", 10),
    },
    update: { name: "Bayan (Editor)" },
  });
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: "admin@pairai.com" } },
    create: {
      tenantId,
      email: "admin@pairai.com",
      name: "PAIR Admin",
      role: "PAIR_ADMIN",
      passwordHash: await bcrypt.hash("password1", 10),
    },
    update: {},
  });
  return { editor, admin };
}

async function issueApiKey(tenantId: string, slug: string) {
  const raw = `tb_live_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  await prisma.apiKey.upsert({
    where: { keyHash: hash },
    create: {
      tenantId,
      keyHash: hash,
      keyPrefix: raw.slice(0, 12),
      label: "Seed bot key",
      scopes: ["read:kb", "write:analytics", "ops:read", "ops:write"],
    },
    update: {},
  });
  console.log(`Seeded ${slug}: api_key = ${raw}`);
}

async function seedFutureKid() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "flare-fitness" },
    create: { slug: "flare-fitness", name: "Flare Fitness", timezone: "Asia/Kuwait" },
    update: { name: "Flare Fitness" },
  });
  const { editor } = await upsertTenantUsers(tenant.id);

  // Drop any modules under this tenant that are no longer in the fixtures.
  const keepSlugs = MODULES.map((m) => m.slug);
  const stale = await prisma.module.findMany({
    where: { tenantId: tenant.id, slug: { notIn: keepSlugs } },
    select: { id: true },
  });
  if (stale.length) {
    const staleIds = stale.map((s) => s.id);
    await prisma.entry.deleteMany({ where: { moduleId: { in: staleIds } } });
    await prisma.module.deleteMany({ where: { id: { in: staleIds } } });
    console.log(`Removed ${stale.length} stale modules + their entries`);
  }

  const moduleIdBySlug = new Map<string, string>();
  for (const mod of MODULES) {
    const row = await prisma.module.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: mod.slug } },
      create: {
        tenantId: tenant.id,
        slug: mod.slug,
        label: mod.label,
        icon: mod.icon ?? null,
        fieldDefinitions: mod.fieldDefinitions as unknown as object,
      },
      update: {
        label: mod.label,
        icon: mod.icon ?? null,
        fieldDefinitions: mod.fieldDefinitions as unknown as object,
      },
    });
    moduleIdBySlug.set(mod.slug, row.id);
  }

  let entryCount = 0;
  let orphanCount = 0;
  for (const [slug, entries] of Object.entries(ENTRIES_BY_SLUG)) {
    const moduleId = moduleIdBySlug.get(slug);
    if (!moduleId) {
      console.warn(`Skipping ${entries.length} entries: no module for slug "${slug}"`);
      continue;
    }
    // Delete previously-seeded entries that are no longer in the fixtures.
    // Only touches rows that carry an externalId (i.e. seeded) — user-created
    // entries (externalId = null) are preserved.
    const fixtureIds = entries.map((e) => e.id);
    const orphans = await prisma.entry.deleteMany({
      where: {
        tenantId: tenant.id,
        moduleId,
        externalId: { not: null, notIn: fixtureIds },
      },
    });
    orphanCount += orphans.count;
    for (const entry of entries) {
      await prisma.entry.upsert({
        where: {
          tenantId_moduleId_externalId: {
            tenantId: tenant.id,
            moduleId,
            externalId: entry.id,
          },
        },
        create: {
          tenantId: tenant.id,
          moduleId,
          externalId: entry.id,
          createdBy: editor.id,
          status: entry.status as EntryStatus,
          data: entry.data as object,
        },
        update: {
          data: entry.data as object,
          status: entry.status as EntryStatus,
        },
      });
      entryCount++;
    }
  }
  if (orphanCount) console.log(`Removed ${orphanCount} orphaned seeded entries`);

  await issueApiKey(tenant.id, "flare-fitness");
  console.log(`Seeded flare-fitness: ${MODULES.length} modules, ${entryCount} entries`);
}

async function main() {
  await seedFutureKid();
  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
