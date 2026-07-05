import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  FieldDefinition,
  type FieldDefinition as FieldDef,
} from "../../../../packages/shared/src/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { createEntry, updateEntry } from "../services/entries.js";
import { bumpVersion } from "../services/cache.js";

/**
 * Contract-first operations layer.
 *
 * Every operation The Brain exposes to agents (FAI) and dashboards is defined
 * ONCE here: name, scope, params schema, handler. The REST dispatch route
 * (routes/ops.ts) is generated from this registry; an MCP surface can be
 * generated from the same definitions later. Add an operation here and every
 * surface gets it, with scope enforcement in one place.
 *
 * Scopes: read < write < admin. API keys need ops:read / ops:write / ops:admin;
 * dashboard JWTs get read+write (viewers read-only), admin needs PAIR_ADMIN.
 */

export type OpScope = "read" | "write" | "admin";

export interface OpContext {
  tx: Prisma.TransactionClient;
  tenantId: string;
  userId?: string;
}

export interface OpDef {
  name: string;
  scope: OpScope;
  description: string;
  params: z.ZodTypeAny;
  example: Record<string, unknown>;
  handler: (ctx: OpContext, params: never) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EntryRow = {
  id: string;
  moduleId: string;
  data: unknown;
  status: string;
  externalId: string | null;
  updatedAt: Date;
};

function entryName(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  return String(d.name ?? d.name_en ?? d.name_ar ?? "(unnamed)");
}

function summarize(entry: { id: string; data: unknown; status: string }, type?: string) {
  return { id: entry.id, type, name: entryName(entry.data), status: entry.status };
}

async function getModuleBySlug(tx: Prisma.TransactionClient, tenantId: string, slug: string) {
  return tx.module.findUnique({ where: { tenantId_slug: { tenantId, slug } } });
}

/** Auto-provision a module the ops layer depends on (conversations, customers, inbox). */
async function ensureModule(
  tx: Prisma.TransactionClient,
  tenantId: string,
  slug: string,
  label: string,
  fields: FieldDef[],
) {
  const existing = await getModuleBySlug(tx, tenantId, slug);
  if (existing) return existing;
  return tx.module.create({
    data: { tenantId, slug, label, fieldDefinitions: fields as unknown as Prisma.InputJsonValue },
  });
}

const CONVERSATION_FIELDS: FieldDef[] = [
  { key: "name", label: "Title", type: "text", required: true, localized: false },
  {
    key: "channel",
    label: "Channel",
    type: "select",
    required: false,
    localized: false,
    options: ["whatsapp", "instagram", "web", "other"],
  },
  { key: "customer_name", label: "Customer", type: "text", required: false, localized: false },
  { key: "started", label: "Started", type: "date", required: false, localized: false },
  { key: "ended", label: "Ended", type: "date", required: false, localized: false },
  {
    key: "escalated",
    label: "Escalated to human",
    type: "boolean",
    required: false,
    localized: false,
  },
  { key: "transcript", label: "Transcript", type: "textarea", required: false, localized: false },
  { key: "summary", label: "Summary", type: "textarea", required: false, localized: false },
];

const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true, localized: false },
  { key: "phone", label: "Phone", type: "text", required: false, localized: false },
  { key: "notes", label: "Notes", type: "textarea", required: false, localized: false },
];

const INBOX_FIELDS: FieldDef[] = [
  { key: "name", label: "Title", type: "text", required: true, localized: false },
  { key: "text", label: "Text", type: "textarea", required: true, localized: false },
  { key: "hint_type", label: "Suggested type", type: "text", required: false, localized: false },
];

/**
 * Deterministic signal detection over customer text (no LLM dependency).
 * Keyword lists cover Kuwaiti/Gulf Arabic and English. Deliberately
 * high-precision, low-recall: a missed signal is recoverable, a false
 * complaint alert erodes trust in the briefing.
 */
const SIGNAL_KEYWORDS: Record<string, string[]> = {
  complaint: [
    "مشكلة",
    "مشكله",
    "خطأ",
    "غلط",
    "شكوى",
    "ما اشتغل",
    "لا يعمل",
    "ما يشتغل",
    "استرجاع",
    "problem",
    "issue",
    "wrong",
    "not working",
    "error",
    "refund",
    "complaint",
  ],
  churn_risk: [
    "الغاء",
    "إلغاء",
    "ألغي",
    "الغي",
    "بطل الاشتراك",
    "ما ابي اكمل",
    "وقفوا الاشتراك",
    "cancel",
    "unsubscribe",
    "stop my subscription",
    "want to stop",
  ],
  sales_intent: [
    "اشتراك",
    "سعر",
    "كم سعر",
    "باقة",
    "عرض",
    "خصم",
    "كود",
    "subscribe",
    "price",
    "discount",
    "offer",
    "how much",
    "code",
  ],
};

export function detectSignals(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const [signal, words] of Object.entries(SIGNAL_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) hits.push(signal);
  }
  return hits;
}

const EntityRef = z.object({
  id: z.string().uuid().optional(),
  type: z.string().optional(),
  external_id: z.string().optional(),
  name: z.string().optional(),
});

async function findEntry(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ref: z.infer<typeof EntityRef>,
): Promise<{ entry: EntryRow; moduleSlug: string }> {
  if (ref.id) {
    const entry = await tx.entry.findUnique({
      where: { id: ref.id },
      include: { module: { select: { slug: true } } },
    });
    if (!entry) throw notFound("Entry not found");
    return { entry, moduleSlug: entry.module.slug };
  }
  if (!ref.type) throw badRequest("Provide id, or type plus external_id/name");
  const mod = await getModuleBySlug(tx, tenantId, ref.type);
  if (!mod) throw notFound(`No module '${ref.type}'`);
  if (ref.external_id) {
    const entry = await tx.entry.findFirst({
      where: { moduleId: mod.id, externalId: ref.external_id },
    });
    if (!entry) throw notFound("Entry not found by external_id");
    return { entry, moduleSlug: mod.slug };
  }
  if (ref.name) {
    const entries = await tx.entry.findMany({ where: { moduleId: mod.id } });
    const match = entries.find((e) => entryName(e.data).toLowerCase() === ref.name!.toLowerCase());
    if (!match) throw notFound(`No '${ref.type}' entry named '${ref.name}'`);
    return { entry: match, moduleSlug: mod.slug };
  }
  throw badRequest("Provide id, external_id, or name");
}

function snippetAround(data: unknown, q: string, radius = 120): string {
  const text = JSON.stringify(data ?? "");
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  return text.slice(start, idx + q.length + radius);
}

async function upsertLink(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fromEntryId: string,
  toEntryId: string,
  edgeType: string,
  userId?: string,
) {
  return tx.entityLink.upsert({
    where: {
      tenantId_fromEntryId_toEntryId_edgeType: { tenantId, fromEntryId, toEntryId, edgeType },
    },
    create: { tenantId, fromEntryId, toEntryId, edgeType, createdBy: userId },
    update: {},
  });
}

function dayWindow(date?: string): { from: Date; to: Date; day: string } {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw badRequest("Invalid date, expected YYYY-MM-DD");
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000), day };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

const query: OpDef = {
  name: "query",
  scope: "read",
  description:
    "Search the tenant's knowledge. Trigram match on name fields plus substring match over all entry data, optionally filtered by type/status. Keyword-only for now: embeddings land behind this same operation.",
  params: z.object({
    question: z.string().min(1).max(300),
    type: z.string().optional(),
    status: z.enum(["draft", "scheduled", "active", "expired", "archived"]).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  example: { question: "كود الخصم", type: "conversations", limit: 5 },
  handler: async (
    { tx },
    p: { question: string; type?: string; status?: string; limit: number },
  ) => {
    const like = `%${p.question}%`;
    const rows = await tx.$queryRaw<
      Array<{ id: string; status: string; data: unknown; module_slug: string; score: number }>
    >`
      SELECT e.id, e.status::text AS status, e.data, m.slug AS module_slug,
        GREATEST(
          similarity(coalesce(e.data->>'name', ''), ${p.question}),
          similarity(coalesce(e.data->>'name_en', ''), ${p.question}),
          similarity(coalesce(e.data->>'name_ar', ''), ${p.question})
        ) AS score
      FROM entries e
      JOIN modules m ON m.id = e.module_id
      WHERE (${p.type ?? null}::text IS NULL OR m.slug = ${p.type ?? null})
        AND (${p.status ?? null}::text IS NULL OR e.status::text = ${p.status ?? null})
        AND (
          (e.data->>'name') % ${p.question}
          OR (e.data->>'name_en') % ${p.question}
          OR (e.data->>'name_ar') % ${p.question}
          OR e.data::text ILIKE ${like}
        )
      ORDER BY score DESC, e.updated_at DESC
      LIMIT ${p.limit}`;
    return {
      results: rows.map((r) => ({
        id: r.id,
        type: r.module_slug,
        name: entryName(r.data),
        status: r.status,
        score: Number(r.score.toFixed(4)),
        snippet: snippetAround(r.data, p.question),
      })),
      retrieval: "keyword",
    };
  },
};

const getEntity: OpDef = {
  name: "get_entity",
  scope: "read",
  description:
    "Fetch one typed entry by id, or by type plus external_id/name. Includes links and recent events.",
  params: EntityRef.refine((r) => r.id || r.type, "Provide id, or type plus external_id/name"),
  example: { type: "customers", name: "Karam Zoubi" },
  handler: async ({ tx, tenantId }, p: z.infer<typeof EntityRef>) => {
    const { entry, moduleSlug } = await findEntry(tx, tenantId, p);
    const [linksFrom, linksTo, events] = await Promise.all([
      tx.entityLink.findMany({
        where: { fromEntryId: entry.id },
        include: { toEntry: { select: { id: true, data: true } } },
      }),
      tx.entityLink.findMany({
        where: { toEntryId: entry.id },
        include: { fromEntry: { select: { id: true, data: true } } },
      }),
      tx.entityEvent.findMany({
        where: { entryId: entry.id },
        orderBy: { occurredAt: "desc" },
        take: 20,
      }),
    ]);
    return {
      id: entry.id,
      type: moduleSlug,
      status: entry.status,
      external_id: entry.externalId,
      updated_at: entry.updatedAt,
      data: entry.data,
      links: [
        ...linksFrom.map((l) => ({
          direction: "out",
          edge_type: l.edgeType,
          id: l.toEntry.id,
          name: entryName(l.toEntry.data),
        })),
        ...linksTo.map((l) => ({
          direction: "in",
          edge_type: l.edgeType,
          id: l.fromEntry.id,
          name: entryName(l.fromEntry.data),
        })),
      ],
      events: events.map((e) => ({
        event_type: e.eventType,
        occurred_at: e.occurredAt,
        note: e.note,
      })),
    };
  },
};

const listEntities: OpDef = {
  name: "list_entities",
  scope: "read",
  description:
    "List entries of one type, optionally by status or updated-since. For sweeps like 'open complaints' or 'leads gone quiet'.",
  params: z.object({
    type: z.string().min(1),
    status: z.enum(["draft", "scheduled", "active", "expired", "archived"]).optional(),
    updated_since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  example: { type: "memberships", status: "active" },
  handler: async (
    { tx, tenantId },
    p: {
      type: string;
      status?: "draft" | "scheduled" | "active" | "expired" | "archived";
      updated_since?: string;
      limit: number;
    },
  ) => {
    const mod = await getModuleBySlug(tx, tenantId, p.type);
    if (!mod) throw notFound(`No module '${p.type}'`);
    const entries = await tx.entry.findMany({
      where: {
        moduleId: mod.id,
        ...(p.status ? { status: p.status } : {}),
        ...(p.updated_since ? { updatedAt: { gte: new Date(p.updated_since) } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: p.limit,
    });
    return {
      type: p.type,
      count: entries.length,
      entities: entries.map((e) => ({
        ...summarize(e, p.type),
        updated_at: e.updatedAt,
        external_id: e.externalId,
      })),
    };
  },
};

const graphQuery: OpDef = {
  name: "graph_query",
  scope: "read",
  description:
    "Walk typed links from an entry, depth 1-2, both directions. 'Everything connected to this customer.'",
  params: z.object({
    id: z.string().uuid(),
    depth: z.number().int().min(1).max(2).default(1),
    edge_type: z.string().optional(),
  }),
  example: { id: "<entry-uuid>", depth: 2 },
  handler: async ({ tx }, p: { id: string; depth: number; edge_type?: string }) => {
    const edges: Array<{ from: string; to: string; edge_type: string; depth: number }> = [];
    const nodeIds = new Set<string>([p.id]);
    let frontier = [p.id];
    for (let d = 1; d <= p.depth; d++) {
      const found = await tx.entityLink.findMany({
        where: {
          ...(p.edge_type ? { edgeType: p.edge_type } : {}),
          OR: [{ fromEntryId: { in: frontier } }, { toEntryId: { in: frontier } }],
        },
      });
      const next: string[] = [];
      for (const l of found) {
        if (
          !edges.some(
            (e) => e.from === l.fromEntryId && e.to === l.toEntryId && e.edge_type === l.edgeType,
          )
        ) {
          edges.push({ from: l.fromEntryId, to: l.toEntryId, edge_type: l.edgeType, depth: d });
        }
        for (const nid of [l.fromEntryId, l.toEntryId]) {
          if (!nodeIds.has(nid)) {
            nodeIds.add(nid);
            next.push(nid);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    const nodes = await tx.entry.findMany({
      where: { id: { in: [...nodeIds] } },
      include: { module: { select: { slug: true } } },
    });
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.module.slug,
        name: entryName(n.data),
        status: n.status,
      })),
      edges,
    };
  },
};

const timeline: OpDef = {
  name: "timeline",
  scope: "read",
  description:
    "Dated events for one entry or across the tenant: joined, renewed, complained, resolved, churned.",
  params: z.object({
    id: z.string().uuid().optional(),
    event_type: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  example: { event_type: "complaint_detected", limit: 20 },
  handler: async (
    { tx },
    p: { id?: string; event_type?: string; from?: string; to?: string; limit: number },
  ) => {
    const events = await tx.entityEvent.findMany({
      where: {
        ...(p.id ? { entryId: p.id } : {}),
        ...(p.event_type ? { eventType: p.event_type } : {}),
        ...(p.from || p.to
          ? {
              occurredAt: {
                ...(p.from ? { gte: new Date(p.from) } : {}),
                ...(p.to ? { lte: new Date(p.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: p.limit,
      include: { entry: { select: { id: true, data: true, module: { select: { slug: true } } } } },
    });
    return {
      events: events.map((e) => ({
        entity: { id: e.entry.id, type: e.entry.module.slug, name: entryName(e.entry.data) },
        event_type: e.eventType,
        occurred_at: e.occurredAt,
        note: e.note,
      })),
    };
  },
};

const dailyBriefing: OpDef = {
  name: "daily_briefing",
  scope: "read",
  description:
    "Owner digest for one day (default today, UTC): entries created/updated by type, events, signals from ingested conversations, open inbox captures.",
  params: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  example: { date: "2026-07-05" },
  handler: async ({ tx, tenantId }, p: { date?: string }) => {
    const { from, to, day } = dayWindow(p.date);
    const [created, updated, events, modules] = await Promise.all([
      tx.entry.findMany({
        where: { createdAt: { gte: from, lt: to } },
        include: { module: { select: { slug: true } } },
      }),
      tx.entry.findMany({
        where: { updatedAt: { gte: from, lt: to }, createdAt: { lt: from } },
        include: { module: { select: { slug: true } } },
      }),
      tx.entityEvent.findMany({
        where: { occurredAt: { gte: from, lt: to } },
        include: {
          entry: { select: { id: true, data: true, module: { select: { slug: true } } } },
        },
        orderBy: { occurredAt: "desc" },
      }),
      tx.module.findMany({ select: { id: true, slug: true } }),
    ]);
    const byType = (rows: Array<{ module: { slug: string } }>) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.module.slug] = (acc[r.module.slug] ?? 0) + 1;
        return acc;
      }, {});
    const inboxMod = modules.find((m) => m.slug === "inbox");
    const openInbox = inboxMod
      ? await tx.entry.count({ where: { moduleId: inboxMod.id, status: "draft" } })
      : 0;
    return {
      day,
      created_by_type: byType(created),
      updated_by_type: byType(updated),
      signals: events
        .filter((e) =>
          ["complaint_detected", "churn_risk_detected", "sales_intent_detected"].includes(
            e.eventType,
          ),
        )
        .map((e) => ({ event_type: e.eventType, entity: entryName(e.entry.data), id: e.entry.id })),
      events: events.slice(0, 20).map((e) => ({
        event_type: e.eventType,
        entity: { id: e.entry.id, type: e.entry.module.slug, name: entryName(e.entry.data) },
        note: e.note,
      })),
      open_inbox_captures: openInbox,
    };
  },
};

const health: OpDef = {
  name: "health",
  scope: "read",
  description:
    "Per-tenant brain stats: entry counts by status, modules, links, events, last write.",
  params: z.object({}),
  example: {},
  handler: async ({ tx }) => {
    const [modules, byStatus, links, events, lastEntry] = await Promise.all([
      tx.module.count(),
      tx.entry.groupBy({ by: ["status"], _count: true }),
      tx.entityLink.count(),
      tx.entityEvent.count(),
      tx.entry.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ]);
    return {
      modules,
      entries_by_status: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      links,
      events,
      last_write: lastEntry?.updatedAt ?? null,
      retrieval: "keyword",
    };
  },
};

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

const IngestMessage = z.object({
  sender: z.string(),
  sender_type: z.enum(["contact", "ai_agent", "human_agent", "system"]),
  ts: z.string(),
  text: z.string(),
});

const ingestConversation: OpDef = {
  name: "ingest_conversation",
  scope: "write",
  description:
    "File a finished conversation thread: upserts the customer, stores the transcript as a conversations entry (idempotent on external_id), links customer to thread, logs events, and runs keyword signal detection (complaint / churn_risk / sales_intent).",
  params: z.object({
    channel: z.enum(["whatsapp", "instagram", "web", "other"]).default("other"),
    external_id: z.string().min(1),
    customer: z.object({ name: z.string().min(1), phone: z.string().optional() }),
    messages: z.array(IngestMessage).min(1).max(2000),
    summary: z.string().optional(),
  }),
  example: {
    channel: "instagram",
    external_id: "ig-01K8ZSWB",
    customer: { name: "Karam Zoubi", phone: "+96599365531" },
    messages: [
      {
        sender: "Karam Zoubi",
        sender_type: "contact",
        ts: "2025-11-01T11:32:02Z",
        text: "الكود ما اشتغل",
      },
    ],
  },
  handler: async (
    { tx, tenantId, userId },
    p: {
      channel: "whatsapp" | "instagram" | "web" | "other";
      external_id: string;
      customer: { name: string; phone?: string };
      messages: Array<z.infer<typeof IngestMessage>>;
      summary?: string;
    },
  ) => {
    const convMod = await ensureModule(
      tx,
      tenantId,
      "conversations",
      "Conversations",
      CONVERSATION_FIELDS,
    );
    const custMod = await ensureModule(tx, tenantId, "customers", "Customers", CUSTOMER_FIELDS);

    const custExternalId = p.customer.phone ?? `name:${p.customer.name.toLowerCase()}`;
    let customer = await tx.entry.findFirst({
      where: { moduleId: custMod.id, externalId: custExternalId },
    });
    if (!customer) {
      customer = await createEntry(tx, {
        tenantId,
        moduleId: custMod.id,
        data: { name: p.customer.name, phone: p.customer.phone ?? "" },
        userId,
        externalId: custExternalId,
      });
    }

    const contactText = p.messages
      .filter((m) => m.sender_type === "contact")
      .map((m) => m.text)
      .join("\n");
    const signals = detectSignals(contactText);
    const escalated = p.messages.some((m) => m.sender_type === "human_agent");
    const startDate = new Date(p.messages[0]!.ts);
    const endDate = new Date(p.messages[p.messages.length - 1]!.ts);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()))
      throw badRequest("Message ts must be ISO datetimes");
    const started = startDate.toISOString();
    const ended = endDate.toISOString();
    const transcript = p.messages
      .map((m) => `[${m.ts.slice(0, 16).replace("T", " ")}] ${m.sender_type}: ${m.text}`)
      .join("\n");
    const data = {
      name: `${p.customer.name} (${started.slice(0, 10)})`,
      channel: p.channel,
      customer_name: p.customer.name,
      started,
      ended,
      escalated,
      transcript,
      summary: p.summary ?? "",
    };

    const existing = await tx.entry.findFirst({
      where: { moduleId: convMod.id, externalId: p.external_id },
    });
    const conversation = existing
      ? await updateEntry(tx, {
          tenantId,
          entryId: existing.id,
          data,
          userId,
          changeSummary: "re-ingested",
        })
      : await createEntry(tx, {
          tenantId,
          moduleId: convMod.id,
          data,
          userId,
          externalId: p.external_id,
        });

    await upsertLink(tx, tenantId, customer.id, conversation.id, "participant", userId);

    const occurredAt = new Date(p.messages[p.messages.length - 1]!.ts);
    await tx.entityEvent.create({
      data: {
        tenantId,
        entryId: conversation.id,
        eventType: "conversation_ingested",
        occurredAt,
        createdBy: userId,
      },
    });
    for (const signal of signals) {
      await tx.entityEvent.create({
        data: {
          tenantId,
          entryId: customer.id,
          eventType: `${signal}_detected`,
          occurredAt,
          note: `From conversation ${p.external_id}`,
          createdBy: userId,
        },
      });
    }

    return { conversation_id: conversation.id, customer_id: customer.id, escalated, signals };
  },
};

const upsertEntity: OpDef = {
  name: "upsert_entity",
  scope: "write",
  description:
    "Create or update a typed entry. Matches by id or (type, external_id); on update, fields merge into existing data. Validates against the module's field definitions, writes a version, bumps the KB cache.",
  params: z.object({
    type: z.string().min(1),
    id: z.string().uuid().optional(),
    external_id: z.string().optional(),
    fields: z.record(z.unknown()),
    status: z.enum(["draft", "scheduled", "active"]).optional(),
  }),
  example: {
    type: "customers",
    external_id: "+96599365531",
    fields: { name: "Karam Zoubi", notes: "Prefers Arabic" },
  },
  handler: async (
    { tx, tenantId, userId },
    p: {
      type: string;
      id?: string;
      external_id?: string;
      fields: Record<string, unknown>;
      status?: "draft" | "scheduled" | "active";
    },
  ) => {
    const mod = await getModuleBySlug(tx, tenantId, p.type);
    if (!mod) throw notFound(`No module '${p.type}'. Create it first via the schema operation.`);
    let existing = null;
    if (p.id) existing = await tx.entry.findUnique({ where: { id: p.id } });
    else if (p.external_id)
      existing = await tx.entry.findFirst({
        where: { moduleId: mod.id, externalId: p.external_id },
      });
    if (existing) {
      const merged = { ...(existing.data as Record<string, unknown>), ...p.fields };
      const updated = await updateEntry(tx, {
        tenantId,
        entryId: existing.id,
        data: merged,
        userId,
      });
      if (p.status && p.status !== existing.status) {
        await tx.entry.update({ where: { id: existing.id }, data: { status: p.status } });
      }
      return { id: updated.id, type: p.type, created: false };
    }
    const created = await createEntry(tx, {
      tenantId,
      moduleId: mod.id,
      data: p.fields,
      userId,
      status: p.status,
      externalId: p.external_id,
    });
    return { id: created.id, type: p.type, created: true };
  },
};

const capture: OpDef = {
  name: "capture",
  scope: "write",
  description:
    "Freeform note into the inbox (draft status) when the caller can't type it yet. Inbox items get filed into typed entries later.",
  params: z.object({ text: z.string().min(1).max(10000), hint_type: z.string().optional() }),
  example: {
    text: "Customers keep asking about the 33% code showing as 10%",
    hint_type: "complaints",
  },
  handler: async ({ tx, tenantId, userId }, p: { text: string; hint_type?: string }) => {
    const mod = await ensureModule(tx, tenantId, "inbox", "Inbox", INBOX_FIELDS);
    const entry = await createEntry(tx, {
      tenantId,
      moduleId: mod.id,
      data: { name: p.text.slice(0, 80), text: p.text, hint_type: p.hint_type ?? "" },
      userId,
      status: "draft",
    });
    return { id: entry.id, type: "inbox" };
  },
};

const linkEntities: OpDef = {
  name: "link_entities",
  scope: "write",
  description:
    "Create a typed edge between two entries (idempotent). Edge types are free-form: participant, used_promo, attends, about.",
  params: z.object({
    from_id: z.string().uuid(),
    to_id: z.string().uuid(),
    edge_type: z.string().min(1).max(50),
  }),
  example: { from_id: "<customer-uuid>", to_id: "<promo-uuid>", edge_type: "used_promo" },
  handler: async (
    { tx, tenantId, userId },
    p: { from_id: string; to_id: string; edge_type: string },
  ) => {
    const [from, to] = await Promise.all([
      tx.entry.findUnique({ where: { id: p.from_id } }),
      tx.entry.findUnique({ where: { id: p.to_id } }),
    ]);
    if (!from || !to) throw notFound("One or both entries not found");
    const link = await upsertLink(tx, tenantId, p.from_id, p.to_id, p.edge_type, userId);
    return { link_id: link.id };
  },
};

const logEvent: OpDef = {
  name: "log_event",
  scope: "write",
  description:
    "Append a dated event to an entry's timeline: joined, renewed, complained, resolved, churned.",
  params: z.object({
    entity_id: z.string().uuid(),
    event_type: z.string().min(1).max(60),
    occurred_at: z.string().datetime().optional(),
    note: z.string().max(2000).optional(),
  }),
  example: { entity_id: "<member-uuid>", event_type: "renewed", note: "3-month plan" },
  handler: async (
    { tx, tenantId, userId },
    p: { entity_id: string; event_type: string; occurred_at?: string; note?: string },
  ) => {
    const entry = await tx.entry.findUnique({ where: { id: p.entity_id } });
    if (!entry) throw notFound("Entry not found");
    const event = await tx.entityEvent.create({
      data: {
        tenantId,
        entryId: p.entity_id,
        eventType: p.event_type,
        occurredAt: p.occurred_at ? new Date(p.occurred_at) : new Date(),
        note: p.note,
        createdBy: userId,
      },
    });
    return { event_id: event.id };
  },
};

const setStatus: OpDef = {
  name: "set_status",
  scope: "write",
  description:
    "Lifecycle status transition on an entry (draft/scheduled/active/expired/archived) with an audit event. Workflow states inside the data (open/resolved) belong in upsert_entity fields.",
  params: z.object({
    id: z.string().uuid(),
    status: z.enum(["draft", "scheduled", "active", "expired", "archived"]),
    reason: z.string().max(500).optional(),
  }),
  example: { id: "<entry-uuid>", status: "archived", reason: "Promo ended" },
  handler: async (
    { tx, tenantId, userId },
    p: {
      id: string;
      status: "draft" | "scheduled" | "active" | "expired" | "archived";
      reason?: string;
    },
  ) => {
    const entry = await tx.entry.findUnique({ where: { id: p.id } });
    if (!entry) throw notFound("Entry not found");
    await tx.entry.update({ where: { id: p.id }, data: { status: p.status } });
    await tx.entityEvent.create({
      data: {
        tenantId,
        entryId: p.id,
        eventType: `status_${p.status}`,
        occurredAt: new Date(),
        note: p.reason,
        createdBy: userId,
      },
    });
    await bumpVersion(tenantId);
    return { id: p.id, status: p.status, previous: entry.status };
  },
};

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

const schemaOp: OpDef = {
  name: "schema",
  scope: "admin",
  description:
    "Get or set the tenant's type definitions (modules). 'set' upserts one module's label/icon/field definitions.",
  params: z.discriminatedUnion("action", [
    z.object({ action: z.literal("get") }),
    z.object({
      action: z.literal("set"),
      type: z.string().regex(/^[a-z][a-z0-9-]*$/),
      label: z.string().min(1),
      icon: z.string().optional(),
      field_definitions: z.array(FieldDefinition).min(1),
    }),
  ]),
  example: { action: "get" },
  handler: async (
    { tx, tenantId },
    p:
      | { action: "get" }
      | {
          action: "set";
          type: string;
          label: string;
          icon?: string;
          field_definitions: FieldDef[];
        },
  ) => {
    if (p.action === "get") {
      const modules = await tx.module.findMany({ orderBy: { slug: "asc" } });
      return {
        types: modules.map((m) => ({
          type: m.slug,
          label: m.label,
          icon: m.icon,
          is_active: m.isActive,
          field_definitions: m.fieldDefinitions,
        })),
      };
    }
    const mod = await tx.module.upsert({
      where: { tenantId_slug: { tenantId, slug: p.type } },
      create: {
        tenantId,
        slug: p.type,
        label: p.label,
        icon: p.icon,
        fieldDefinitions: p.field_definitions as unknown as Prisma.InputJsonValue,
      },
      update: {
        label: p.label,
        icon: p.icon,
        fieldDefinitions: p.field_definitions as unknown as Prisma.InputJsonValue,
      },
    });
    await bumpVersion(tenantId);
    return { type: mod.slug, id: mod.id };
  },
};

const reindex: OpDef = {
  name: "reindex",
  scope: "admin",
  description:
    "Invalidate the tenant's KB cache and report index state. Embedding backfill will hang off this operation when vector search lands.",
  params: z.object({}),
  example: {},
  handler: async ({ tx, tenantId }) => {
    const version = await bumpVersion(tenantId);
    const entries = await tx.entry.count();
    return {
      cache_version: version,
      entries,
      embeddings: "not configured (keyword retrieval only)",
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const operations: Record<string, OpDef> = Object.fromEntries(
  [
    query,
    getEntity,
    listEntities,
    graphQuery,
    timeline,
    dailyBriefing,
    health,
    ingestConversation,
    upsertEntity,
    capture,
    linkEntities,
    logEvent,
    setStatus,
    schemaOp,
    reindex,
  ].map((op) => [op.name, op]),
);
