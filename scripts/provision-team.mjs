#!/usr/bin/env node
/**
 * Provision Flare/Macro team accounts on The Brain.
 *
 * Idempotent: re-running skips accounts that already exist (the admin /users
 * route 409s on a duplicate email, which we treat as "already provisioned").
 * Each new account gets a generated password, printed ONCE to stdout. There is
 * no password-recovery path in the API, so capture the output.
 *
 * Usage:
 *   BRAIN_ADMIN_EMAIL=admin@pairai.com \
 *   BRAIN_ADMIN_PASSWORD='...' \
 *   node scripts/provision-team.mjs [path/to/roster.json]
 *
 * Env (all optional except the admin password):
 *   BRAIN_BASE_URL      default https://brain-flare.vercel.app/api/v1
 *   BRAIN_TENANT_SLUG   default flare-fitness
 *   BRAIN_ADMIN_EMAIL   default admin@pairai.com
 *   BRAIN_ADMIN_PASSWORD  (required)
 *
 * Roster file (JSON array). If omitted, the DEFAULT_ROSTER below is used:
 *   [ { "name": "Full Name", "email": "person@...", "role": "CLIENT_EDITOR" } ]
 * Valid roles: PAIR_ADMIN | CLIENT_EDITOR | CLIENT_VIEWER | API_CONSUMER
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BRAIN_BASE_URL ?? "https://brain-flare.vercel.app/api/v1";
const TENANT_SLUG = process.env.BRAIN_TENANT_SLUG ?? "flare-fitness";
const ADMIN_EMAIL = process.env.BRAIN_ADMIN_EMAIL ?? "admin@pairai.com";
const ADMIN_PASSWORD = process.env.BRAIN_ADMIN_PASSWORD;

// Edit this list, or pass a roster.json path as argv[2].
const DEFAULT_ROSTER = [
  // { name: "Bayan (Flare)", email: "bayan@flarefitness.com", role: "CLIENT_EDITOR" },
  // { name: "Macro Ops",     email: "ops@macro.??",          role: "CLIENT_EDITOR" },
];

const VALID_ROLES = new Set(["PAIR_ADMIN", "CLIENT_EDITOR", "CLIENT_VIEWER", "API_CONSUMER"]);

/** URL-safe, ~20 chars, satisfies the min-8 rule with margin. */
function genPassword() {
  return randomBytes(15).toString("base64url");
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
  return { token: json.data.token, tenantId: json.data.tenant.id };
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
      "Roster is empty. Edit DEFAULT_ROSTER in this file or pass a roster.json path.\n" +
        'Format: [{ "name": "...", "email": "...", "role": "CLIENT_EDITOR" }]',
    );
    process.exit(1);
  }

  for (const m of roster) {
    if (!m.name || !m.email || !VALID_ROLES.has(m.role)) {
      throw new Error(`Bad roster entry: ${JSON.stringify(m)} (need name, email, valid role)`);
    }
  }

  console.log(`Provisioning ${roster.length} account(s) on ${BASE} (tenant: ${TENANT_SLUG})\n`);
  const { token, tenantId } = await login();

  const created = [];
  for (const member of roster) {
    const password = genPassword();
    const { status, json } = await api("/admin/users", {
      method: "POST",
      token,
      body: { tenantId, email: member.email, password, name: member.name, role: member.role },
    });

    if (status === 200 && json?.success) {
      created.push({ ...member, password });
      console.log(`  created  ${member.email.padEnd(34)} ${member.role}`);
    } else if (status === 409 || /exists|duplicate|unique/i.test(JSON.stringify(json))) {
      console.log(`  exists   ${member.email.padEnd(34)} (skipped)`);
    } else {
      console.log(`  FAILED   ${member.email.padEnd(34)} ${status}: ${JSON.stringify(json)}`);
    }
  }

  if (created.length) {
    console.log("\n--- CREDENTIALS (shown once, capture now) ---");
    console.log(`Login at: ${BASE.replace(/\/api\/v1$/, "")}   tenant: ${TENANT_SLUG}\n`);
    for (const c of created) {
      console.log(`${c.name}\n  email:    ${c.email}\n  password: ${c.password}\n  role:     ${c.role}\n`);
    }
    console.log("Ask each person to log in and change their password on first use.");
  } else {
    console.log("\nNo new accounts created (all already existed).");
  }
}

main().catch((err) => {
  console.error("\nprovision-team failed:", err.message);
  process.exit(1);
});
