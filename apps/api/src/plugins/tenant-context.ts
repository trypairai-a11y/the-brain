import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../lib/prisma.js";
import { adminBypassTotal } from "../lib/metrics.js";
import type { Prisma } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    tenantId?: string;
    isAdmin?: boolean;
    /** Runs `fn` inside a transaction with `SET LOCAL app.tenant_id` so RLS policies fire. */
    withTenant: <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
      opts?: { timeout?: number },
    ) => Promise<T>;
  }
}

/**
 * Per-request tenant context. Every DB query MUST go through `request.withTenant(...)`.
 * Prisma does not emit `SET LOCAL` automatically, so we wrap every query in a transaction
 * so the session variable lives for the same statement set.
 */
const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("tenantId", undefined);
  app.decorateRequest("isAdmin", false);
  app.decorateRequest("withTenant", null as any);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.withTenant = async (fn, opts) => {
      if (!req.tenantId && !req.isAdmin) {
        throw new Error("tenant context not set");
      }
      return prisma.$transaction(
        async (tx) => {
          if (req.isAdmin) {
            adminBypassTotal.labels("tenant-context").inc();
            await tx.$executeRawUnsafe(`SET LOCAL app.is_admin = 'true'`);
          }
          if (req.tenantId) {
            // uuid cast; Prisma escapes the bound param
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${req.tenantId}, true)`;
          }
          return fn(tx);
        },
        opts?.timeout ? { timeout: opts.timeout } : undefined,
      );
    };
  });
};

export default fp(plugin, { name: "tenant-context" });
