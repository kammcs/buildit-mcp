/**
 * Hand-written, minimal types for the two endpoints this version uses:
 * GET /v1/meta and GET /v1/me.
 *
 * The agent API's OpenAPI document is the contract. Once it is copied into
 * this repo, these schemas are replaced by ones generated from it (see
 * CLAUDE.md). Until then they are deliberately tolerant: unknown fields are
 * kept, and only the fields the server relies on are required.
 */
import { z } from 'zod';

/** GET /v1/meta: the API version and the oldest MCP server version it supports. */
export const MetaSchema = z.looseObject({
  api_version: z.string().optional(),
  min_mcp_version: z.string().optional(),
});
export type Meta = z.infer<typeof MetaSchema>;

const IdList = z.array(z.string()).nullable().optional();

/** GET /v1/me: who the token acts as, in which org, with which scopes and limits. */
export const MeSchema = z.looseObject({
  user: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
  }),
  org: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
  }),
  token: z
    .looseObject({
      id: z.string().optional(),
      name: z.string().optional(),
      expires_at: z.string().optional(),
    })
    .optional(),
  scopes: z.array(z.string()),
  /** Null or absent lists mean "everything the user can see". */
  limits: z
    .looseObject({
      projects: IdList,
      channels: IdList,
    })
    .optional(),
  /** The projects in the token's reach. */
  projects: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        key: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
export type Me = z.infer<typeof MeSchema>;

/** The API's error envelope. */
export const ErrorEnvelopeSchema = z.object({
  error: z.looseObject({
    code: z.string(),
    message: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
