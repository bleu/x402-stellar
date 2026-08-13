import pg from "pg";

import { logger } from "../../utils/logger.js";
import { type Embedder, toVectorLiteral } from "./embedder.js";
import type { AssetPrice } from "../prices/index.js";

/** Pool or a checked-out client, so writes can share one transaction. */
type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

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
  extensions?: Record<string, unknown>;
  /**
   * Row identity for MCP tools. Not part of the spec's DiscoveryResource -- a
   * client reads the tool name from `extensions.bazaar` -- but callers need it
   * to tell two tools on one endpoint apart.
   */
  toolName?: string;
  /** Present only where settlement history exists. Absent means no traffic. */
  quality?: ResourceQuality;
}

/**
 * A row as written. Adds the fields that identify and shape an endpoint but
 * are not part of the served DiscoveryResource: `toolName` distinguishes MCP
 * tools sharing one endpoint, `method` and `routeTemplate` arrive from the
 * resource server's extension enrichment.
 */
export interface CatalogRecord extends Omit<CatalogResource, "lastUpdated"> {
  toolName?: string;
  method?: string;
  routeTemplate?: string;
  /** Never served; distinguishes the synthetic seed corpus from real traffic. */
  source?: "settlement" | "seed";
}

/** Identifies one catalog row: an endpoint, or one MCP tool on an endpoint. */
export interface ResourceKey {
  resource: string;
  toolName?: string;
}

/** One settlement observed for a resource. */
export interface SettlementEvent extends ResourceKey {
  asset: string;
  payer?: string;
  /** Defaults to now; settable so tests and seeds can backdate history. */
  settledAt?: Date;
}

/** Usage signals derived from settlement history. Mirrors CDP's shape. */
export interface ResourceQuality {
  l30DaysTotalCalls: number;
  l30DaysUniquePayers: number;
  lastCalledAt: string;
}

/**
 * Map key for a ResourceKey. `toolName` is part of row identity, so a plain
 * endpoint and an MCP tool on the same URL must not collide. A space separates
 * them unambiguously because a URL cannot contain an unencoded one.
 */
export function resourceKey({ resource, toolName }: ResourceKey): string {
  return toolName ? `${resource} ${toolName}` : resource;
}

/**
 * Hard constraints on a result set, shared by /discovery/resources and
 * /discovery/search. Price filters judge what settlements observed, not what a
 * server declares: `accepts` is built from payments seen, so an option a server
 * has stopped offering can linger.
 */
export interface CatalogFilters {
  /** Spec filters. */
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  /** Extension key that must be present on the resource, e.g. "bazaar". */
  extensions?: string;
  /** Any-of over the assets a resource accepts. */
  asset?: string[];
  /** Atomic units of the single named asset; ignored unless exactly one asset. */
  maxAmount?: string;
  /** Any-of over tags. */
  tags?: string[];
  /** Case-insensitive substring of the resource url. */
  urlSubstring?: string;
}

export interface ListFilters extends CatalogFilters {
  limit: number;
  offset: number;
}

/** Collects positional parameters while predicates are assembled. */
class Params {
  readonly values: unknown[] = [];

  /** Appends a value and returns its `$n` placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Turns filters into SQL predicates. Search applies these inside each ranking
 * arm rather than trimming afterwards, so they bind as hard constraints instead
 * of quietly shrinking a page of results.
 */
function buildPredicates(filters: CatalogFilters, params: Params): string[] {
  const where: string[] = [];

  if (filters.type) where.push(`type = ${params.add(filters.type)}`);

  // scheme/network/payTo match an entry of the accepts array via containment.
  const acceptsFilter: Record<string, string> = {};
  if (filters.scheme) acceptsFilter.scheme = filters.scheme;
  if (filters.network) acceptsFilter.network = filters.network;
  if (filters.payTo) acceptsFilter.payTo = filters.payTo;
  if (Object.keys(acceptsFilter).length > 0) {
    where.push(`accepts @> ${params.add(JSON.stringify([acceptsFilter]))}::jsonb`);
  }

  if (filters.extensions) where.push(`extensions ? ${params.add(filters.extensions)}`);

  // maxAmount is comparable only against a named asset, since atomic units are
  // per-asset. With one asset both bind to the same accepts entry.
  if (filters.asset?.length === 1 && filters.maxAmount !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(accepts) e
                WHERE e->>'asset' = ${params.add(filters.asset[0])}
                  AND (e->>'amount')::numeric <= ${params.add(filters.maxAmount)}::numeric)`,
    );
  } else if (filters.asset?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(accepts) e
                WHERE e->>'asset' = ANY(${params.add(filters.asset)}::text[]))`,
    );
  }

  if (filters.tags?.length) where.push(`tags ?| ${params.add(filters.tags)}::text[]`);

  if (filters.urlSubstring) {
    where.push(`resource ILIKE '%' || ${params.add(filters.urlSubstring)} || '%'`);
  }

  return where;
}

/**
 * The text the lexical arm searches. Built in application code rather than from
 * a column expression so the same wording feeds the embedding document.
 * The url path contributes with separators turned into spaces, so
 * `/weather/forecast` yields the words a query would use.
 */
export function buildSearchDocument(record: CatalogRecord): string {
  return [...commonDocumentParts(record), ...outputExampleKeys(record)].filter(Boolean).join(" ");
}

/** The text both documents share. */
function commonDocumentParts(record: CatalogRecord): (string | undefined)[] {
  const parts = [record.serviceName, record.description, record.tags?.join(" "), record.toolName];
  try {
    parts.push(new URL(record.resource).pathname.replace(/[/\-_.:]+/g, " ").trim());
  } catch {
    // A resource that is not a parsable URL still gets the rest of its text.
  }
  parts.push(inputParameterNames(record).join(" "));
  return parts;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Parameter names only; their schemas are boilerplate to a sentence embedding. */
function inputParameterNames(record: CatalogRecord): string[] {
  const input = (record.extensions?.bazaar as any)?.info?.input;
  if (!input || typeof input !== "object") return [];
  const maps = [input.queryParams, input.pathParams, input.body, input.inputSchema?.properties];
  const names = new Set<string>();
  for (const map of maps) {
    if (map && typeof map === "object") Object.keys(map).forEach((name) => names.add(name));
  }
  if (typeof input.toolName === "string") names.add(input.toolName);
  return [...names];
}

/** Response field names, searchable lexically but not worth an embedding slot. */
function outputExampleKeys(record: CatalogRecord): string[] {
  const example = (record.extensions?.bazaar as any)?.info?.output?.example;
  if (!example || typeof example !== "object") return [];
  return Object.keys(example);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The text that gets embedded. Deliberately tighter than the lexical document:
 * all-MiniLM-L6-v2 truncates at 256 word-pieces, so schema and response
 * boilerplate would eat the budget, push the description out, and drag every
 * embedding closer together. Parameter names are included, their schemas are
 * not.
 */
export function buildEmbedDocument(record: CatalogRecord): string {
  return commonDocumentParts(record).filter(Boolean).join(" ");
}

/**
 * Turns a natural-language query into an OR-ed tsquery.
 *
 * `plainto_tsquery` and `websearch_to_tsquery` both AND their lexemes, so
 * "current weather for a city" becomes `current & weather & citi` and matches
 * almost nothing. OR-ing lets `ts_rank_cd` order partial matches instead of the
 * arm silently returning empty.
 */
function toOredTsQuery(query: string): string | null {
  const lexemes = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
  return lexemes.length > 0 ? lexemes.join(" | ") : null;
}

/** The served DiscoveryResource fields, plus the tool name for row identity. */
const RESOURCE_COLUMN_NAMES = [
  "resource",
  "tool_name",
  "type",
  "x402_version",
  "accepts",
  "extensions",
  "description",
  "mime_type",
  "service_name",
  "tags",
  "icon_url",
  "last_updated",
];

/** Column list, optionally table-qualified for queries that join. */
function resourceColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return RESOURCE_COLUMN_NAMES.map((name) => `${prefix}${name}`).join(", ");
}

/**
 * RRF's rank offset. 60 is the value from the original paper and the usual
 * default; it damps the gap between the top few ranks so one arm's confident
 * first place cannot dominate the other arm entirely.
 */
const RRF_K = 60;

/** How deep each arm looks before fusion. */
const ARM_CANDIDATES = 50;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toCatalogResource(row: any): CatalogResource {
  return {
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
    ...(row.extensions ? { extensions: row.extensions } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Postgres-backed store for discovered resources. One row per resource URL,
 * upserted on settlement; Phase 2's Bazaar extension processing writes here too.
 */
export class CatalogStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embedder: Embedder,
  ) {}

  static connect(databaseUrl: string, embedder: Embedder): CatalogStore {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    // An unhandled pool 'error' event (e.g. an idle client dropped by a
    // Postgres restart) is fatal to the process. The pool discards the dead
    // client before emitting, so logging is the only action left to take.
    pool.on("error", (err) => logger.error({ err }, "Catalog pool error"));
    return new CatalogStore(pool, embedder);
  }

  /**
   * Pre-production, so this is create-if-absent with no migration handling:
   * adding a column here means recreating the dev volume.
   *
   * A `DATABASE_URL` without pgvector fails here, which surfaces as a startup
   * error rather than a search that silently degrades.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_resources (
        resource        text NOT NULL,
        tool_name       text,
        type            text NOT NULL,
        method          text,
        route_template  text,
        x402_version    int  NOT NULL,
        accepts         jsonb NOT NULL,
        extensions      jsonb,
        description     text,
        mime_type       text,
        service_name    text,
        tags            jsonb,
        icon_url        text,
        source          text NOT NULL DEFAULT 'settlement',
        search_document text NOT NULL DEFAULT '',
        search_tsv      tsvector GENERATED ALWAYS AS
                          (to_tsvector('english'::regconfig, search_document)) STORED,
        embedding       vector(384),
        last_updated    timestamptz NOT NULL DEFAULT now(),
        -- One row per (endpoint, MCP tool). NULLS NOT DISTINCT (Postgres 15+)
        -- makes the single NULL tool_name of an HTTP resource collide with
        -- itself, so plain endpoints keep one row while MCP tools sharing an
        -- endpoint each get their own.
        UNIQUE NULLS NOT DISTINCT (resource, tool_name)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS catalog_resources_search_tsv_idx
         ON catalog_resources USING GIN (search_tsv)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS catalog_resources_embedding_idx
         ON catalog_resources USING hnsw (embedding vector_cosine_ops)`,
    );
    // Append-only settlement log. Payer addresses are public chain data and are
    // the only way to count distinct payers; see the README.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_settlements (
        id         bigserial PRIMARY KEY,
        resource   text NOT NULL,
        tool_name  text,
        asset      text NOT NULL,
        payer      text,
        settled_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS catalog_settlements_resource_idx
         ON catalog_settlements (resource, tool_name, settled_at DESC)`,
    );
    // Survives a restart, so maxUsdPrice keeps working before the first poll.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS asset_usd_prices (
        asset        text PRIMARY KEY,
        coingecko_id text NOT NULL,
        usd_price    numeric NOT NULL,
        fetched_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  /** Price persistence, kept here so the catalog owns one connection pool. */
  async savePrices(prices: AssetPrice[]): Promise<void> {
    for (const price of prices) {
      await this.pool.query(
        `INSERT INTO asset_usd_prices (asset, coingecko_id, usd_price, fetched_at)
         VALUES ($1, $2, $3::numeric, $4)
         ON CONFLICT (asset) DO UPDATE SET
           coingecko_id = EXCLUDED.coingecko_id,
           usd_price = EXCLUDED.usd_price,
           fetched_at = EXCLUDED.fetched_at`,
        [price.asset, price.coingeckoId, price.usdPrice, price.fetchedAt],
      );
    }
  }

  async loadPrices(): Promise<{ asset: string; usdPrice: string; fetchedAt: Date }[]> {
    const result = await this.pool.query(
      `SELECT asset, usd_price, fetched_at FROM asset_usd_prices`,
    );
    return result.rows.map((row) => ({
      asset: row.asset,
      usdPrice: String(row.usd_price),
      fetchedAt: row.fetched_at,
    }));
  }

  /**
   * Test helper: drops the catalog tables so a test run owns its schema.
   * `ensureSchema` only creates what is absent, so a database left over from an
   * older column set would otherwise silently keep it.
   */
  async dropSchemaForTests(): Promise<void> {
    await this.pool.query(
      `DROP TABLE IF EXISTS catalog_resources, catalog_settlements, asset_usd_prices`,
    );
  }

  /** Test helper: empties the catalog between cases. */
  async truncateForTests(): Promise<void> {
    await this.pool.query(`TRUNCATE catalog_resources, catalog_settlements`);
  }

  /** Test helper: reproduces rows awaiting a background embedding fill. */
  async clearEmbeddingsForTests(): Promise<void> {
    await this.pool.query(`UPDATE catalog_resources SET embedding = NULL`);
  }

  /** Appends one settlement to the history behind the quality signals. */
  async appendSettlement(event: SettlementEvent, executor: Queryable = this.pool): Promise<void> {
    await executor.query(
      `INSERT INTO catalog_settlements (resource, tool_name, asset, payer, settled_at)
       VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`,
      [
        event.resource,
        event.toolName ?? null,
        event.asset,
        event.payer ?? null,
        event.settledAt ?? null,
      ],
    );
  }

  /**
   * Records a paid resource and the settlement that revealed it, atomically.
   * Splitting the two would let a failed settlement insert leave a resource row
   * whose usage counts silently understate reality.
   */
  async upsertWithSettlement(record: CatalogRecord, event: SettlementEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.upsert(record, client);
      await this.appendSettlement(event, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Usage signals for the given rows, in one query rather than per resource.
   * Rows nobody has paid are absent from the map rather than reported as zero,
   * so callers can tell "no traffic" from "no data".
   */
  async quality(keys: ResourceKey[]): Promise<Map<string, ResourceQuality>> {
    if (keys.length === 0) return new Map();

    // Filtered by resource only, then grouped by (resource, tool_name): a row
    // comparison against a NULL tool_name never matches, so the tool split is
    // resolved in the map below rather than in SQL. Callers pass at most a
    // page of keys, so pulling sibling tools of the same endpoint is cheap.
    const result = await this.pool.query(
      `SELECT resource,
              tool_name,
              count(*)::int              AS total_calls,
              count(DISTINCT payer)::int AS unique_payers,
              max(settled_at)            AS last_called_at
       FROM catalog_settlements
       WHERE settled_at >= now() - interval '30 days'
         AND resource = ANY($1::text[])
       GROUP BY resource, tool_name`,
      [[...new Set(keys.map((k) => k.resource))]],
    );

    const quality = new Map<string, ResourceQuality>();
    for (const row of result.rows) {
      quality.set(resourceKey({ resource: row.resource, toolName: row.tool_name ?? undefined }), {
        l30DaysTotalCalls: row.total_calls,
        l30DaysUniquePayers: row.unique_payers,
        lastCalledAt: row.last_called_at.toISOString(),
      });
    }
    return quality;
  }

  /**
   * One accepts entry per call (the requirements the settlement used). On
   * conflict the entry for the same asset is replaced and other assets are
   * kept, so multi-asset resources accumulate options with fresh amounts.
   * Options a server stops accepting linger until declaration-based
   * population (STE-61) replaces settlement observation.
   */
  async upsert(resource: CatalogRecord, executor: Queryable = this.pool): Promise<void> {
    // Embedding runs inline on the settle path, a known cost on the money path.
    // The first thing to improve after the PoC is writing the row synchronously
    // and filling `embedding` from a background sweep of NULL rows.
    const embedding = await this.embedder.embed(buildEmbedDocument(resource));

    await executor.query(
      `INSERT INTO catalog_resources (resource, tool_name, type, method, route_template, x402_version, accepts, extensions, description, mime_type, service_name, tags, icon_url, source, search_document, embedding, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::vector, now())
       ON CONFLICT (resource, tool_name) DO UPDATE SET
         type = EXCLUDED.type,
         method = EXCLUDED.method,
         route_template = EXCLUDED.route_template,
         x402_version = EXCLUDED.x402_version,
         accepts = (
           SELECT coalesce(jsonb_agg(entry), '[]'::jsonb)
           FROM jsonb_array_elements(catalog_resources.accepts) entry
           WHERE entry->>'asset' IS DISTINCT FROM EXCLUDED.accepts->0->>'asset'
         ) || EXCLUDED.accepts,
         extensions = EXCLUDED.extensions,
         description = EXCLUDED.description,
         mime_type = EXCLUDED.mime_type,
         service_name = EXCLUDED.service_name,
         tags = EXCLUDED.tags,
         icon_url = EXCLUDED.icon_url,
         source = EXCLUDED.source,
         search_document = EXCLUDED.search_document,
         embedding = EXCLUDED.embedding,
         last_updated = now()`,
      [
        resource.resource,
        resource.toolName ?? null,
        resource.type,
        resource.method ?? null,
        resource.routeTemplate ?? null,
        resource.x402Version,
        JSON.stringify(resource.accepts),
        resource.extensions ? JSON.stringify(resource.extensions) : null,
        resource.description ?? null,
        resource.mimeType ?? null,
        resource.serviceName ?? null,
        resource.tags ? JSON.stringify(resource.tags) : null,
        resource.iconUrl ?? null,
        resource.source ?? "settlement",
        buildSearchDocument(resource),
        toVectorLiteral(embedding),
      ],
    );
  }

  /**
   * The lexical half of hybrid search: full-text ranking over search_document,
   * best first. Filters bind here rather than after fusion so they stay hard
   * constraints.
   */
  async searchLexical(
    query: string,
    filters: CatalogFilters,
    limit: number,
  ): Promise<CatalogResource[]> {
    const tsquery = toOredTsQuery(query);
    if (!tsquery) return [];

    const params = new Params();
    const queryParam = params.add(tsquery);
    const where = buildPredicates(filters, params);
    where.push(`search_tsv @@ to_tsquery('english', ${queryParam})`);

    const result = await this.pool.query(
      `SELECT ${resourceColumns()}
       FROM catalog_resources
       WHERE ${where.join(" AND ")}
       ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', ${queryParam})) DESC, resource
       LIMIT ${params.add(limit)}`,
      params.values,
    );

    return result.rows.map(toCatalogResource);
  }

  /**
   * The semantic half of hybrid search: nearest neighbours by cosine distance,
   * best first. Rows without an embedding cannot be ranked and drop out.
   */
  async searchVector(
    query: string,
    filters: CatalogFilters,
    limit: number,
  ): Promise<CatalogResource[]> {
    const embedding = await this.embedder.embed(query);

    const params = new Params();
    const queryVector = params.add(toVectorLiteral(embedding));
    const where = buildPredicates(filters, params);
    where.push(`embedding IS NOT NULL`);

    const result = await this.pool.query(
      `SELECT ${resourceColumns()}
       FROM catalog_resources
       WHERE ${where.join(" AND ")}
       ORDER BY embedding <=> ${queryVector}::vector, resource
       LIMIT ${params.add(limit)}`,
      params.values,
    );

    return result.rows.map(toCatalogResource);
  }

  /**
   * Hybrid search: reciprocal rank fusion over the lexical and vector arms.
   *
   * Each arm applies every filter and takes its own top ARM_CANDIDATES, then the
   * two are joined on row identity and scored by the sum of 1/(k + rank). RRF
   * needs only the ranks, so the arms' incomparable scores -- ts_rank_cd and
   * cosine distance -- never have to be put on one scale. It also discards score
   * magnitude, which does not matter at this corpus size but would be worth
   * revisiting with tunable weights at scale.
   *
   * A FULL OUTER JOIN keeps resources only one arm found, so a row with no
   * embedding still ranks lexically.
   */
  async search(query: string, filters: CatalogFilters, limit: number): Promise<CatalogResource[]> {
    const tsquery = toOredTsQuery(query);
    const embedding = await this.embedder.embed(query);

    const params = new Params();
    const queryVector = params.add(toVectorLiteral(embedding));
    // An empty tsquery matches nothing rather than everything, so a query of
    // only stopwords degrades to the vector arm instead of returning the corpus.
    const tsqueryParam = params.add(tsquery ?? "");
    const armFilters = buildPredicates(filters, params);
    const filterSql = armFilters.length > 0 ? `AND ${armFilters.join(" AND ")}` : "";
    const candidates = params.add(ARM_CANDIDATES);
    const rrfK = params.add(RRF_K);

    const result = await this.pool.query(
      `WITH lexical AS (
         SELECT resource, tool_name,
                row_number() OVER (
                  ORDER BY ts_rank_cd(search_tsv, to_tsquery('english', ${tsqueryParam})) DESC, resource
                ) AS rank
         FROM catalog_resources
         WHERE ${tsqueryParam} <> ''
           AND search_tsv @@ to_tsquery('english', ${tsqueryParam})
           ${filterSql}
         LIMIT ${candidates}
       ),
       semantic AS (
         SELECT resource, tool_name,
                row_number() OVER (ORDER BY embedding <=> ${queryVector}::vector, resource) AS rank
         FROM catalog_resources
         WHERE embedding IS NOT NULL
           ${filterSql}
         LIMIT ${candidates}
       ),
       fused AS (
         SELECT coalesce(l.resource, s.resource)   AS resource,
                coalesce(l.tool_name, s.tool_name) AS tool_name,
                coalesce(1.0 / (${rrfK} + l.rank), 0)
                  + coalesce(1.0 / (${rrfK} + s.rank), 0) AS score
         FROM lexical l
         FULL OUTER JOIN semantic s
           ON s.resource = l.resource AND s.tool_name IS NOT DISTINCT FROM l.tool_name
       )
       SELECT ${resourceColumns("c")}, f.score
       FROM fused f
       JOIN catalog_resources c
         ON c.resource = f.resource AND c.tool_name IS NOT DISTINCT FROM f.tool_name
       ORDER BY f.score DESC, c.resource
       LIMIT ${params.add(limit)}`,
      params.values,
    );

    logger.debug(
      { query, hits: result.rows.map((row) => ({ resource: row.resource, score: row.score })) },
      "Hybrid search ranking",
    );

    // Attached here rather than by the caller: only the store holds the tool
    // name that distinguishes two MCP tools sharing one endpoint.
    const ranked = result.rows.map(toCatalogResource);
    const quality = await this.quality(ranked);
    return ranked.map((item) => {
      const signals = quality.get(resourceKey(item));
      return signals ? { ...item, quality: signals } : item;
    });
  }

  async list(filters: ListFilters): Promise<{ items: CatalogResource[]; total: number }> {
    const params = new Params();
    const where = buildPredicates(filters, params);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await this.pool.query(
      `SELECT count(*)::int AS total FROM catalog_resources ${whereSql}`,
      params.values,
    );

    const limit = params.add(filters.limit);
    const offset = params.add(filters.offset);
    const rowsResult = await this.pool.query(
      `SELECT ${resourceColumns()}
       FROM catalog_resources ${whereSql}
       ORDER BY last_updated DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params.values,
    );

    return {
      items: rowsResult.rows.map(toCatalogResource),
      total: countResult.rows[0].total,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
