import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { operations, type OpScope } from "../ops/operations.js";

/**
 * Contract-first ops dispatch. The registry in ops/operations.ts is the single
 * source of truth; this route just authenticates, enforces scope, validates
 * params, and runs the handler inside the tenant-scoped transaction.
 *
 *   GET  /api/v1/ops         list operations (name, scope, description, example)
 *   POST /api/v1/ops/:name   invoke one operation, body = params
 *
 * Callers: FAI and other agents use tb_live_ API keys carrying ops:read /
 * ops:write / ops:admin scopes. Dashboard JWTs get read+write (viewers
 * read-only); admin ops require PAIR_ADMIN.
 */

const SCOPE_TO_KEY_SCOPE: Record<OpScope, string> = {
  read: "ops:read",
  write: "ops:write",
  admin: "ops:admin",
};

function assertAccess(req: FastifyRequest, scope: OpScope) {
  if (req.apiKeyScopes) {
    const needed = SCOPE_TO_KEY_SCOPE[scope];
    if (!req.apiKeyScopes.includes(needed)) throw forbidden(`API key missing scope ${needed}`);
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (scope === "admin" && !req.isAdmin) throw forbidden("Admin operation");
  if (scope === "write" && role === "CLIENT_VIEWER") throw forbidden("Read-only role");
}

const routes: FastifyPluginAsync = async (app) => {
  // Dual auth: tb_live_ keys go through the API-key plugin, everything else JWT.
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer tb_live_")) await app.apiKeyAuth(req);
    else await app.authenticate(req);
  });

  app.get("/", async (req) => {
    const ops = Object.values(operations).map((op) => ({
      name: op.name,
      scope: op.scope,
      description: op.description,
      example: op.example,
    }));
    return { success: true, data: { operations: ops }, meta: { count: ops.length } };
  });

  app.post("/:name", async (req) => {
    const { name } = req.params as { name: string };
    const op = operations[name];
    if (!op) throw notFound(`Unknown operation '${name}'`);
    assertAccess(req, op.scope);

    const parsed = op.params.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.message, "INVALID_OP_PARAMS");

    const tenantId = req.tenantId!;
    const userId = (req.user as { sub?: string } | undefined)?.sub;

    // Ops like ingest_conversation legitimately do several writes per call;
    // give them a larger interactive-transaction budget than the 5s default.
    const data = await req.withTenant(
      async (tx) => {
        const result = await op.handler({ tx, tenantId, userId }, parsed.data as never);
        if (op.scope !== "read") {
          await tx.auditLog.create({
            data: {
              tenantId,
              userId,
              action: `ops:${op.name}`,
              entityType: "ops",
              diff: truncateForAudit(parsed.data) as Prisma.InputJsonValue,
            },
          });
        }
        return result;
      },
      { timeout: 15_000 },
    );

    return { success: true, data, meta: { operation: op.name } };
  });
};

/** Keep audit rows bounded: replace large message arrays with a count. */
function truncateForAudit(params: unknown): unknown {
  if (params && typeof params === "object" && "messages" in (params as Record<string, unknown>)) {
    const p = params as Record<string, unknown>;
    const messages = p.messages as unknown[];
    return { ...p, messages: `[${messages.length} messages]` };
  }
  return params;
}

export default routes;
