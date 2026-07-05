import { z } from "zod";

export const Role = z.enum(["PAIR_ADMIN", "CLIENT_EDITOR", "CLIENT_VIEWER", "API_CONSUMER"]);
export type Role = z.infer<typeof Role>;

export const ApiScope = z.enum([
  "read:kb",
  "write:analytics",
  "ops:read",
  "ops:write",
  "ops:admin",
]);
export type ApiScope = z.infer<typeof ApiScope>;
