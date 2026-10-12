import { isIPv4 } from "node:net";
import sql from "mssql";
import { printerSchema, type PrinterProfile } from "../shared/model.js";

export const PRINTER_CATALOG_QUERY =
  "SELECT printer_id, name, location, description, brand, ip, date_added FROM dbo.printersZPL ORDER BY name, printer_id";
export interface CatalogDiagnostic {
  printerId?: number;
  severity: "warning";
  code: string;
  message: string;
}
export interface CatalogResult {
  printers: PrinterProfile[];
  diagnostics: CatalogDiagnostic[];
  refreshedAt: string;
}
export interface PrinterCatalog {
  enabled: boolean;
  list(fresh?: boolean): Promise<CatalogResult>;
  resolve(id: string): Promise<PrinterProfile>;
  close(): Promise<void>;
}
const unavailable = () =>
  Object.assign(
    new Error(
      "SQL printer catalog is unavailable; check server configuration and read-only database access.",
    ),
    {
      statusCode: 503,
      publicMessage:
        "SQL printer catalog is unavailable; check server configuration and read-only database access.",
    },
  );
export function createPrinterCatalog(
  options: {
    enabled?: boolean;
    query?: () => Promise<any[]>;
    env?: NodeJS.ProcessEnv;
    ttlMs?: number;
    poolFactory?: (config: sql.config) => sql.ConnectionPool;
  } = {},
): PrinterCatalog {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.SQL_PRINTERS_ENABLED === "true";
  let pool: sql.ConnectionPool | undefined;
  let connection: Promise<sql.ConnectionPool> | undefined;
  let cached: CatalogResult | undefined;
  const query =
    options.query ??
    (async () => {
      if (!env.SQL_PRINTERS_USER || !env.SQL_PRINTERS_PASSWORD)
        throw unavailable();
      if (!connection) {
        const config: sql.config = {
          server: env.SQL_PRINTERS_SERVER ?? "BYAPPS",
          database: env.SQL_PRINTERS_DATABASE ?? "LabelPrint",
          user: env.SQL_PRINTERS_USER,
          password: env.SQL_PRINTERS_PASSWORD,
          port: Number(env.SQL_PRINTERS_PORT ?? 1433),
          connectionTimeout: 10000,
          requestTimeout: 10000,
          pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
          options: {
            encrypt: env.SQL_PRINTERS_ENCRYPT !== "false",
            trustServerCertificate:
              env.SQL_PRINTERS_TRUST_SERVER_CERTIFICATE === "true",
          },
        };
        const instance = options.poolFactory
          ? options.poolFactory(config)
          : new sql.ConnectionPool(config);
        pool = instance;
        const releaseFailed = async () => {
          if (pool === instance) {
            pool = undefined;
            connection = undefined;
          }
          await instance.close().catch(() => {});
        };
        instance.on("error", () => void releaseFailed());
        connection = instance.connect().catch(async (error) => {
          await releaseFailed();
          throw error;
        });
      }
      const connected = await connection;
      return (await connected.request().query(PRINTER_CATALOG_QUERY)).recordset;
    });
  const api: PrinterCatalog = {
    enabled,
    async list(fresh = false) {
      if (!enabled)
        return {
          printers: [],
          diagnostics: [],
          refreshedAt: new Date().toISOString(),
        };
      if (
        !fresh &&
        cached &&
        Date.now() - Date.parse(cached.refreshedAt) < (options.ttlMs ?? 3000)
      )
        return cached;
      let rows: any[];
      try {
        rows = await query();
      } catch {
        cached = undefined;
        throw unavailable();
      }
      const diagnostics: CatalogDiagnostic[] = [
        {
          severity: "warning",
          code: "UNVERIFIED_SQL_PROFILE",
          message:
            "The catalog has no resolution or media fields; the configured rendering defaults require physical printer validation.",
        },
      ];
      const printers: PrinterProfile[] = [];
      const seen = new Set<number>();
      for (const row of rows) {
        const printerId = row.printer_id;
        const ip = typeof row.ip === "string" ? row.ip.trim() : "";
        if (
          !Number.isInteger(printerId) ||
          seen.has(printerId) ||
          !isIPv4(ip) ||
          typeof row.name !== "string" ||
          !row.name.trim()
        ) {
          diagnostics.push({
            printerId: Number.isInteger(printerId) ? printerId : undefined,
            severity: "warning",
            code: "INVALID_SQL_PRINTER",
            message: `Catalog printer ${String(printerId)} was excluded: invalid identifier, name, duplicate row, or IPv4 address.`,
          });
          continue;
        }
        seen.add(printerId);
        const parsed = printerSchema.safeParse({
          id: `sql:${printerId}`,
          name: row.name.trim(),
          host: ip,
          port: Number(env.SQL_PRINTERS_ZPL_PORT ?? 9100),
          dotsPerMm: Number(env.SQL_PRINTERS_DOTS_PER_MM ?? 8),
          widthDots: Number(env.SQL_PRINTERS_WIDTH_DOTS ?? 832),
          offsetX: 0,
          offsetY: 0,
          model: "SQL catalog · unverified configured ZPL profile",
          media: "gap",
          source: "sql",
          description:
            typeof row.description === "string" ? row.description : undefined,
          location: row.location == null ? null : row.location,
          brand: typeof row.brand === "string" ? row.brand : undefined,
          dateAdded:
            row.date_added instanceof Date
              ? row.date_added.toISOString()
              : undefined,
        });
        if (!parsed.success)
          throw Object.assign(
            new Error("Invalid SQL printer rendering profile configuration."),
            { statusCode: 503 },
          );
        printers.push(parsed.data);
      }
      cached = { printers, diagnostics, refreshedAt: new Date().toISOString() };
      return cached;
    },
    async resolve(id) {
      if (!enabled)
        throw Object.assign(new Error("SQL printer catalog is disabled"), {
          statusCode: 503,
        });
      const result = await api.list(true);
      const printer = result.printers.find((p) => p.id === id);
      if (!printer)
        throw Object.assign(
          new Error("SQL printer no longer exists or has invalid catalog data"),
          { statusCode: 409 },
        );
      return printer;
    },
    async close() {
      await pool?.close();
      connection = undefined;
      cached = undefined;
    },
  };
  return api;
}
