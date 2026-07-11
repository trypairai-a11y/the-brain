#!/usr/bin/env node
/**
 * Provision Flare/Macro team accounts on The Brain.
 *
 * Tenant-aware + idempotent. A roster entry may target one or more tenants via a
 * `tenants` array (slugs). Any tenant that does not yet exist is created via the
 * admin `POST /tenants` route (PAIR_ADMIN writes are cross-tenant), so a single
 * run can stand up a brand-new tenant AND provision its users.
 *
 * Idempotency:
 *   - Users: the admin /users route 409s on a duplicate (tenantId, email), which
 *     we treat as "already provisioned" and skip.
 *   - Tenants: resolved ids are cached to scripts/.tenant-cache.json (gitignored)
 *     so re-runs reuse the id instead of trying to re-create the tenant.
 *
 * Each new person gets ONE generated password, reused across all their tenant
 * accounts and printed ONCE to stdout. There is no password-recovery path in the
 * API, so capture the output and deliver each password to its owner privately
 * (do NOT reply-all with everyone's passwords).
 *
 * Usage:
 *   BRAIN_ADMIN_EMAIL=admin@pairai.com \
 *   BRAIN_ADMIN_PASSWORD='...' \
 *   node scripts/provision-team.mjs scripts/roster.fai-review.json
 *
 * Env (all optional except the admin password):
 *   BRAIN_BASE_URL      default https://brain-flare.vercel.app/api/v1
 *   BRAIN_TENANT_SLUG   admin login tenant + default for entries without `tenants`
 *                       (default flare-fitness)
 *   BRAIN_ADMIN_EMAIL   default admin@pairai.com
 *   BRAIN_ADMIN_PASSWORD  (required)
 *
 * Roster file (JSON array). If omitted, DEFAULT_ROSTER below is used:
 *   [ { "name": "Full Name", "email": "person@...", "role": "CLIENT_EDITOR",
 *       "tenants": ["flare-fitness", "macro"] } ]
 *   `tenants` is optional; omit it to target BRAIN_TENANT_SLUG only.
 *   Valid roles: PAIR_ADMIN | CLIENT_EDITOR | CLIENT_VIEWER | API_CONSUMER
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.BRAIN_BASE_URL ?? "https://brain-flare.vercel.app/api/v1";
const TENANT_SLUG = process.env.BRAIN_TENANT_SLUG ?? "flare-fitness";
const ADMIN_EMAIL = process.env.BRAIN_ADMIN_EMAIL ?? "admin@pairai.com";
const ADMIN_PASSWORD = process.env.BRAIN_ADMIN_PASSWORD;

const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), ".tenant-cache.json");

// Definitions used to auto-create a tenant the first time it is referenced.
// A slug not listed here must already exist (we can only look it up via cache).
const TENANT_DEFS = {
  "flare-fitness": { slug: "flare-fitness", name: "Flare Fitness", timezone: "Asia/Kuwait" },
  macro: { slug: "macro", name: "Macro", timezone: "Asia/Kuwait" },
};

const DEFAULT_ROSTER = [
  // { name: "Bayan (Flare)", email: "bayan@flarefitness.com", role: "CLIENT_EDITOR" },
];

const VALID_ROLES = new Set(["PAIR_ADMIN", "CLIENT_EDITOR", "CLIENT_VIEWER", "API_CONSUMER"]);

/** URL-safe, ~20 chars, satisfies the min-8 rule with margin. */
function genPassword() {
  return randomBytes(15).toString("base64url");
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login() {
  const { status, json } = await api("/auth/login", {
    method: "POST",
    body: { tenantSlug: TENANT_SLUG, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (status !== 200 || !json?.data?.token) {
    throw new Error(`Admin login failed (${status}): ${JSON.stringify(json)}`);
  }
  return { token: json.data.token, loginTenant: json.data.tenant };
}

/** Resolve a tenant slug to an id: cache -> create (if a def exists) -> error. */
async function ensureTenant(slug, token, cache) {
  if (cache[slug]) return cache[slug];

  const def = TENANT_DEFS[slug];
  if (!def) {
    throw new Error(
      `Tenant "${slug}" is unknown and not cached. Add it to TENANT_DEFS or pre-create it.`,
    );
  }

  const { status, json } = await api("/tenants", { method: "POST", token, body: def });
  if (status === 200 && json?.data?.id) {
    cache[slug] = json.data.id;
    saveCache(cache);
    console.log(`  tenant   ${slug.padEnd(34)} created (${json.data.id})`);
    return json.data.id;
  }

  // Likely already exists (unique slug -> P2002) but we have no lookup route and
  // no cached id. Surface a clear, actionable error instead of guessing.
  throw new Error(
    `Could not resolve tenant "${slug}" (create returned ${status}: ${JSON.stringify(json)}). ` +
      `If it already exists, add its id to ${CACHE_PATH} as {"${slug}":"<uuid>"} and re-run.`,
  );
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.error("Set BRAIN_ADMIN_PASSWORD (the PAIR_ADMIN account password).");
    process.exit(1);
  }

  const rosterPath = process.argv[2];
  const roster = rosterPath ? JSON.parse(readFileSync(rosterPath, "utf8")) : DEFAULT_ROSTER;

  if (!Array.isArray(roster) || roster.length === 0) {
    console.error(
      "Roster is empty. Pass a roster.json path or edit DEFAULT_ROSTER.\n" +
        'Format: [{ "name": "...", "email": "...", "role": "CLIENT_EDITOR", "tenants": ["flare-fitness"] }]',
    );
    process.exit(1);
  }

  for (const m of roster) {
    if (!m.name || !m.email || !VALID_ROLES.has(m.role)) {
      throw new Error(`Bad roster entry: ${JSON.stringify(m)} (need name, email, valid role)`);
    }
  }

  console.log(`Provisioning ${roster.length} person(s) on ${BASE}\n`);
  const cache = loadCache();
  const { token, loginTenant } = await login();
  cache[loginTenant.slug] = loginTenant.id; // trust the live id over any stale cache
  saveCache(cache);

  const results = [];
  for (const member of roster) {
    const slugs = member.tenants?.length ? member.tenants : [TENANT_SLUG];
    const password = genPassword();
    const grants = []; // { slug, status: created|exists|failed }
    let anyCreated = false;

    for (const slug of slugs) {
      const tenantId = await ensureTenant(slug, token, cache);
      const { status, json } = await api("/admin/users", {
        method: "POST",
        token,
        body: { tenantId, email: member.email, password, name: member.name, role: member.role },
      });

      if (status === 200 && json?.success) {
        grants.push({ slug, status: "created" });
        anyCreated = true;
        console.log(`  created  ${member.email.padEnd(30)} ${member.role.padEnd(13)} @ ${slug}`);
      } else if (status === 409 || /exists|duplicate|unique/i.test(JSON.stringify(json))) {
        grants.push({ slug, status: "exists" });
        console.log(`  exists   ${member.email.padEnd(30)} ${"".padEnd(13)} @ ${slug} (skipped)`);
      } else {
        grants.push({ slug, status: "failed" });
        console.log(`  FAILED   ${member.email.padEnd(30)} @ ${slug} ${status}: ${JSON.stringify(json)}`);
      }
    }

    results.push({ ...member, password: anyCreated ? password : null, grants });
  }

  const withNew = results.filter((r) => r.password);
  if (withNew.length) {
    console.log("\n--- CREDENTIALS (shown once, capture now) ---");
    console.log(`Login at: ${BASE.replace(/\/api\/v1$/, "/")}   (deliver each password privately)\n`);
    for (const c of withNew) {
      const tenants = c.grants.filter((g) => g.status !== "failed").map((g) => g.slug).join(", ");
      console.log(
        `${c.name}\n  email:    ${c.email}\n  password: ${c.password}\n  role:     ${c.role}\n  tenants:  ${tenants}\n`,
      );
    }
    console.log("Ask each person to log in and change their password on first use (POST /me/password).");
  } else {
    console.log("\nNo new accounts created (all already existed).");
  }
}

main().catch((err) => {
  console.error("\nprovision-team failed:", err.message);
  process.exit(1);
});
