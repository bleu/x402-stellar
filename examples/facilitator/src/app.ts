import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { createHash, timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import proxyAddr from "proxy-addr";

import { Env } from "./config/env.js";
import { createFacilitatorModule } from "./modules/facilitator/index.js";
import type { CatalogModule } from "./modules/catalog/index.js";
import { logger, httpLogger } from "./utils/logger.js";

export function createApp(catalog?: CatalogModule): Express {
  const app: Express = express();

  app.set("trust proxy", proxyAddr.compile(Env.trustProxy));
  app.use(helmet());
  app.use(cors({ origin: Env.corsOrigins }));
  app.use(httpLogger);
  app.use(express.json());

  const expectedApiKey = Env.apiKey;
  function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    if (!expectedApiKey) {
      next();
      return;
    }
    const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    // Hash both values with SHA-256 before comparing so that (a) the buffers are
    // always the same length (avoiding a length-based timing side-channel) and
    // (b) timingSafeEqual can run to completion regardless of key length.
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expectedApiKey).digest();
    if (!timingSafeEqual(providedHash, expectedHash)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // Rate-limit auth-protected endpoints to mitigate brute-force against the API key
  // and to cap resource consumption on /verify (RPC simulation) and /settle (XLM fees).
  const authRateLimit = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too Many Requests" },
  });

  app.use(["/verify", "/settle", "/supported"], authRateLimit, requireApiKey);
  app.use("/discovery", authRateLimit);

  const facilitator = createFacilitatorModule(catalog);
  app.use(facilitator.router);

  if (catalog) {
    app.use(catalog.router);
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Global error handler (Express requires all 4 parameters for error middleware)
  app.use(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ err }, "Unhandled error");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    },
  );

  return app;
}
