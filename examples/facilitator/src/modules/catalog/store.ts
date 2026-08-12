import pg from "pg";

import { logger } from "../../utils/logger.js";

/** Shape follows @x402/extensions/bazaar DiscoveryResource. */
export interface CatalogResource {
  resource: string;
  type: string;
  x402Version: number;
  accepts: Record<string, unknown>[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface ListFilters {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  limit: number;
  offset: number;
}

/**
 * Postgres-backed store for discovered resources. One row per resource URL,
 * upserted on settlement; Phase 2's Bazaar extension processing writes here too.
 */
export class CatalogStore {
  constructor(private readonly pool: pg.Pool) {}

  static connect(databaseUrl: string): CatalogStore {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    // An unhandled pool 'error' event (e.g. an idle client dropped by a
    // Postgres restart) is fatal to the process. The pool discards the dead
    // client before emitting, so logging is the only action left to take.
    pool.on("error", (err) => logger.error({ err }, "Catalog pool error"));
    return new CatalogStore(pool);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_resources (
        resource      text PRIMARY KEY,
        type          text NOT NULL,
        x402_version  int  NOT NULL,
        accepts       jsonb NOT NULL,
        description   text,
        mime_type     text,
        service_name  text,
        tags          jsonb,
        icon_url      text,
        last_updated  timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  /**
   * One accepts entry per call (the requirements the settlement used). On
   * conflict the entry for the same asset is replaced and other assets are
   * kept, so multi-asset resources accumulate options with fresh amounts.
   * Options a server stops accepting linger until declaration-based
   * population (STE-61) replaces settlement observation.
   */
  async upsert(resource: Omit<CatalogResource, "lastUpdated">): Promise<void> {
    await this.pool.query(
      `INSERT INTO catalog_resources (resource, type, x402_version, accepts, description, mime_type, service_name, tags, icon_url, last_updated)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, now())
       ON CONFLICT (resource) DO UPDATE SET
         type = EXCLUDED.type,
         x402_version = EXCLUDED.x402_version,
         accepts = (
           SELECT coalesce(jsonb_agg(entry), '[]'::jsonb)
           FROM jsonb_array_elements(catalog_resources.accepts) entry
           WHERE entry->>'asset' IS DISTINCT FROM EXCLUDED.accepts->0->>'asset'
         ) || EXCLUDED.accepts,
         description = EXCLUDED.description,
         mime_type = EXCLUDED.mime_type,
         service_name = EXCLUDED.service_name,
         tags = EXCLUDED.tags,
         icon_url = EXCLUDED.icon_url,
         last_updated = now()`,
      [
        resource.resource,
        resource.type,
        resource.x402Version,
        JSON.stringify(resource.accepts),
        resource.description ?? null,
        resource.mimeType ?? null,
        resource.serviceName ?? null,
        resource.tags ? JSON.stringify(resource.tags) : null,
        resource.iconUrl ?? null,
      ],
    );
  }

  async list(filters: ListFilters): Promise<{ items: CatalogResource[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.type) {
      params.push(filters.type);
      where.push(`type = $${params.length}`);
    }
    // scheme/network/payTo filter on the accepts array via JSONB containment
    const acceptsFilter: Record<string, string> = {};
    if (filters.scheme) acceptsFilter.scheme = filters.scheme;
    if (filters.network) acceptsFilter.network = filters.network;
    if (filters.payTo) acceptsFilter.payTo = filters.payTo;
    if (Object.keys(acceptsFilter).length > 0) {
      params.push(JSON.stringify([acceptsFilter]));
      where.push(`accepts @> $${params.length}::jsonb`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const countResult = await this.pool.query(
      `SELECT count(*)::int AS total FROM catalog_resources ${whereSql}`,
      params,
    );

    params.push(filters.limit, filters.offset);
    const rowsResult = await this.pool.query(
      `SELECT resource, type, x402_version, accepts, description, mime_type, service_name, tags, icon_url, last_updated
       FROM catalog_resources ${whereSql}
       ORDER BY last_updated DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const items: CatalogResource[] = rowsResult.rows.map((row) => ({
      resource: row.resource,
      type: row.type,
      x402Version: row.x402_version,
      accepts: row.accepts,
      lastUpdated: row.last_updated.toISOString(),
      ...(row.description ? { description: row.description } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.service_name ? { serviceName: row.service_name } : {}),
      ...(row.tags ? { tags: row.tags } : {}),
      ...(row.icon_url ? { iconUrl: row.icon_url } : {}),
    }));

    return { items, total: countResult.rows[0].total };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
