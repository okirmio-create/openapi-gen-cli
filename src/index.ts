import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, basename, extname } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  additionalProperties?: SchemaObject | boolean;
  items?: SchemaObject;
  required?: string[];
  allOf?: (SchemaObject | RefObject)[];
  oneOf?: (SchemaObject | RefObject)[];
  anyOf?: (SchemaObject | RefObject)[];
  nullable?: boolean;
  enum?: unknown[];
  $ref?: string;
}

interface RefObject {
  $ref: string;
}

interface MediaTypeObject {
  schema?: SchemaObject | RefObject;
}

interface RequestBodyObject {
  required?: boolean;
  content: Record<string, MediaTypeObject>;
}

interface ResponseObject {
  description: string;
  content?: Record<string, MediaTypeObject>;
}

interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema?: SchemaObject;
  description?: string;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
}

interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
}

interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  paths?: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject | RefObject>;
  };
  definitions?: Record<string, SchemaObject | RefObject>;
}

// ─── Spec loader ──────────────────────────────────────────────────────────────

function loadSpec(specPath: string): OpenAPISpec {
  const abs = resolve(process.cwd(), specPath);
  if (!existsSync(abs)) {
    console.error(chalk.red(`Spec file not found: ${abs}`));
    process.exit(1);
  }

  const raw = readFileSync(abs, "utf8");
  const ext = extname(abs).toLowerCase();

  if (ext === ".json") {
    try {
      return JSON.parse(raw) as OpenAPISpec;
    } catch (e) {
      console.error(chalk.red(`Invalid JSON: ${(e as Error).message}`));
      process.exit(1);
    }
  }

  // Minimal YAML parser for OpenAPI specs
  try {
    return parseYaml(raw) as OpenAPISpec;
  } catch (e) {
    console.error(chalk.red(`Failed to parse YAML: ${(e as Error).message}`));
    process.exit(1);
  }
}

function parseYaml(yaml: string): unknown {
  // Strip comments, then convert to JSON-compatible structure
  const lines = yaml.split("\n");
  return parseYamlLines(lines, 0).value;
}

interface ParseResult {
  value: unknown;
  nextIndex: number;
}

function parseYamlLines(lines: string[], startIndex: number, baseIndent = 0): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) { i++; continue; }

    const currentIndent = stripped.length - stripped.trimStart().length;
    if (currentIndent < baseIndent) break;
    if (currentIndent > baseIndent) { i++; continue; }

    const trimmed = stripped.trim();

    // List item
    if (trimmed.startsWith("- ")) {
      // Fall back to array parsing
      return parseYamlArray(lines, startIndex, baseIndent);
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "" || rest === "|" || rest === ">") {
      // Value is on next lines
      i++;
      const nextLine = lines[i] ?? "";
      const nextStripped = nextLine.replace(/#.*$/, "").trimEnd();
      const nextIndent = nextStripped.length - nextStripped.trimStart().length;

      if (nextIndent > currentIndent) {
        const nextTrimmed = nextStripped.trim();
        if (nextTrimmed.startsWith("- ")) {
          const arrResult = parseYamlArray(lines, i, nextIndent);
          result[key] = arrResult.value;
          i = arrResult.nextIndex;
        } else {
          const objResult = parseYamlLines(lines, i, nextIndent);
          result[key] = objResult.value;
          i = objResult.nextIndex;
        }
      } else {
        result[key] = null;
      }
    } else {
      result[key] = parseScalar(rest);
      i++;
    }
  }

  return { value: result, nextIndex: i };
}

function parseYamlArray(lines: string[], startIndex: number, baseIndent: number): ParseResult {
  const result: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) { i++; continue; }

    const currentIndent = stripped.length - stripped.trimStart().length;
    if (currentIndent < baseIndent) break;

    const trimmed = stripped.trim();
    if (!trimmed.startsWith("- ")) break;

    const itemContent = trimmed.slice(2).trim();
    if (itemContent.includes(":") && !itemContent.startsWith("'") && !itemContent.startsWith('"')) {
      // Inline object or key
      const colonIdx = itemContent.indexOf(":");
      const key = itemContent.slice(0, colonIdx).trim();
      const val = itemContent.slice(colonIdx + 1).trim();

      const obj: Record<string, unknown> = {};
      if (val) {
        obj[key] = parseScalar(val);
      } else {
        obj[key] = null;
      }

      // Check for more keys at higher indent
      i++;
      const subIndent = baseIndent + 2;
      while (i < lines.length) {
        const subLine = lines[i];
        const subStripped = subLine.replace(/#.*$/, "").trimEnd();
        if (!subStripped.trim()) { i++; continue; }
        const subCurrentIndent = subStripped.length - subStripped.trimStart().length;
        if (subCurrentIndent <= baseIndent) break;
        const subTrimmed = subStripped.trim();
        const subColon = subTrimmed.indexOf(":");
        if (subColon === -1) { i++; continue; }
        const subKey = subTrimmed.slice(0, subColon).trim();
        const subRest = subTrimmed.slice(subColon + 1).trim();
        if (subRest === "") {
          // nested
          i++;
          const nextLine = lines[i] ?? "";
          const nextStripped = nextLine.replace(/#.*$/, "").trimEnd();
          const nextIndent = nextStripped.length - nextStripped.trimStart().length;
          if (nextIndent > subCurrentIndent) {
            const r = parseYamlLines(lines, i, nextIndent);
            obj[subKey] = r.value;
            i = r.nextIndex;
          }
        } else {
          obj[subKey] = parseScalar(subRest);
          i++;
        }
      }
      result.push(obj);
    } else {
      result.push(parseScalar(itemContent));
      i++;
    }
  }

  return { value: result, nextIndex: i };
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSchemas(spec: OpenAPISpec): Record<string, SchemaObject | RefObject> {
  return spec.components?.schemas ?? spec.definitions ?? {};
}

function resolveRef(ref: string, spec: OpenAPISpec): SchemaObject | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let obj: unknown = spec;
  for (const part of parts) {
    if (typeof obj !== "object" || obj === null) return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  return obj as SchemaObject;
}

function schemaToTs(
  schema: SchemaObject | RefObject | undefined,
  spec: OpenAPISpec,
  indent = 0,
  seen = new Set<string>()
): string {
  if (!schema) return "unknown";

  if ("$ref" in schema) {
    const name = schema.$ref.split("/").pop() ?? "unknown";
    return name;
  }

  const s = schema as SchemaObject;
  const pad = "  ".repeat(indent);

  if (s.nullable) {
    const inner = schemaToTs({ ...s, nullable: false } as SchemaObject, spec, indent, seen);
    return `${inner} | null`;
  }

  if (s.oneOf || s.anyOf) {
    const variants = (s.oneOf ?? s.anyOf)!;
    return variants.map((v) => schemaToTs(v, spec, indent, seen)).join(" | ");
  }

  if (s.allOf) {
    return s.allOf.map((v) => schemaToTs(v, spec, indent, seen)).join(" & ");
  }

  if (s.enum) {
    return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  switch (s.type) {
    case "string":
      return s.format === "date" || s.format === "date-time" ? "string" : "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${schemaToTs(s.items, spec, indent, seen)}>`;
    case "object": {
      if (s.additionalProperties && typeof s.additionalProperties !== "boolean") {
        return `Record<string, ${schemaToTs(s.additionalProperties, spec, indent + 1, seen)}>`;
      }
      if (!s.properties || Object.keys(s.properties).length === 0) {
        return "Record<string, unknown>";
      }
      const required = new Set(s.required ?? []);
      const fields = Object.entries(s.properties)
        .map(([key, val]) => {
          const opt = required.has(key) ? "" : "?";
          const desc = (val as SchemaObject).description;
          const comment = desc ? `\n${pad}  /** ${desc} */\n${pad}  ` : `\n${pad}  `;
          return `${comment}${key}${opt}: ${schemaToTs(val, spec, indent + 1, seen)};`;
        })
        .join("");
      return `{${fields}\n${pad}}`;
    }
    default:
      return "unknown";
  }
}

function toPascalCase(s: string): string {
  return s.replace(/[-_/{}](.)/g, (_, c: string) => c.toUpperCase()).replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

function toCamelCase(s: string): string {
  const pascal = toPascalCase(s);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function writeOutput(content: string, outPath: string): void {
  const dir = dirname(outPath);
  if (dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outPath, content, "utf8");
  console.log(chalk.green("✓") + ` Written to ${chalk.bold(outPath)}`);
}

// ─── Command: types ───────────────────────────────────────────────────────────

function cmdTypes(specPath: string, options: { output?: string; prefix?: string }): void {
  const spec = loadSpec(specPath);
  const schemas = getSchemas(spec);
  const prefix = options.prefix ?? "";

  const lines: string[] = [
    `// Generated by openapi-gen-cli`,
    `// Source: ${basename(specPath)}`,
    `// Do not edit manually`,
    ``,
  ];

  const schemaNames = Object.keys(schemas);
  if (schemaNames.length === 0) {
    console.warn(chalk.yellow("No schemas found in components/schemas or definitions"));
  }

  for (const [name, schema] of Object.entries(schemas)) {
    const typeName = `${prefix}${toPascalCase(name)}`;

    if ("$ref" in schema) {
      const target = schema.$ref.split("/").pop() ?? "unknown";
      lines.push(`export type ${typeName} = ${prefix}${toPascalCase(target)};`, ``);
      continue;
    }

    const s = schema as SchemaObject;

    if (s.description) {
      lines.push(`/** ${s.description} */`);
    }

    if (s.type === "object" || (!s.type && s.properties)) {
      const required = new Set(s.required ?? []);
      lines.push(`export interface ${typeName} {`);
      for (const [propName, propSchema] of Object.entries(s.properties ?? {})) {
        if ((propSchema as SchemaObject).description) {
          lines.push(`  /** ${(propSchema as SchemaObject).description} */`);
        }
        const opt = required.has(propName) ? "" : "?";
        lines.push(`  ${propName}${opt}: ${schemaToTs(propSchema, spec, 1)};`);
      }
      if (s.additionalProperties && typeof s.additionalProperties !== "boolean") {
        lines.push(`  [key: string]: ${schemaToTs(s.additionalProperties, spec, 1)};`);
      }
      lines.push(`}`, ``);
    } else if (s.allOf || s.oneOf || s.anyOf || s.enum) {
      lines.push(`export type ${typeName} = ${schemaToTs(s, spec, 0)};`, ``);
    } else if (s.type === "string" || s.type === "integer" || s.type === "number" || s.type === "boolean" || s.type === "array") {
      lines.push(`export type ${typeName} = ${schemaToTs(s, spec, 0)};`, ``);
    } else {
      lines.push(`export type ${typeName} = ${schemaToTs(s, spec, 0)};`, ``);
    }
  }

  const output = options.output ?? "types.ts";
  const content = lines.join("\n");
  writeOutput(content, output);
  console.log(chalk.dim(`  ${schemaNames.length} types generated`));
}

// ─── Command: client ──────────────────────────────────────────────────────────

function cmdClient(specPath: string, options: { output?: string; adapter?: string; baseUrl?: string }): void {
  const spec = loadSpec(specPath);
  const adapter = (options.adapter ?? "fetch") as "fetch" | "axios";
  const paths = spec.paths ?? {};
  const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

  const lines: string[] = [
    `// Generated by openapi-gen-cli`,
    `// Source: ${basename(specPath)}`,
    `// Do not edit manually`,
    ``,
  ];

  if (adapter === "axios") {
    lines.push(`import axios, { AxiosInstance, AxiosResponse } from 'axios';`, ``);
  }

  // Config interface
  lines.push(`export interface ClientConfig {`);
  lines.push(`  baseUrl: string;`);
  lines.push(`  headers?: Record<string, string>;`);
  if (adapter === "fetch") {
    lines.push(`  fetchFn?: typeof fetch;`);
  }
  lines.push(`}`, ``);

  // Types for request/response
  lines.push(`export interface ApiError {`);
  lines.push(`  status: number;`);
  lines.push(`  message: string;`);
  lines.push(`  body?: unknown;`);
  lines.push(`}`, ``);

  // Client class
  const title = spec.info?.title ?? "Api";
  const className = toPascalCase(title.replace(/\s+/g, "")) + "Client";

  lines.push(`export class ${className} {`);

  if (adapter === "axios") {
    lines.push(`  private readonly http: AxiosInstance;`, ``);
    lines.push(`  constructor(config: ClientConfig) {`);
    lines.push(`    this.http = axios.create({`);
    lines.push(`      baseURL: config.baseUrl,`);
    lines.push(`      headers: config.headers,`);
    lines.push(`    });`);
    lines.push(`  }`, ``);
  } else {
    lines.push(`  private readonly baseUrl: string;`);
    lines.push(`  private readonly headers: Record<string, string>;`);
    lines.push(`  private readonly fetchFn: typeof fetch;`, ``);
    lines.push(`  constructor(config: ClientConfig) {`);
    lines.push(`    this.baseUrl = config.baseUrl.replace(/\\/$/, '');`);
    lines.push(`    this.headers = config.headers ?? {};`);
    lines.push(`    this.fetchFn = config.fetchFn ?? fetch;`);
    lines.push(`  }`, ``);

    // Generic request helper
    lines.push(`  private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {`);
    lines.push(`    const url = new URL(this.baseUrl + path);`);
    lines.push(`    if (params) {`);
    lines.push(`      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));`);
    lines.push(`    }`);
    lines.push(`    const res = await this.fetchFn(url.toString(), {`);
    lines.push(`      method,`);
    lines.push(`      headers: { 'Content-Type': 'application/json', ...this.headers },`);
    lines.push(`      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),`);
    lines.push(`    });`);
    lines.push(`    if (!res.ok) {`);
    lines.push(`      const errBody = await res.json().catch(() => ({}));`);
    lines.push(`      const err: ApiError = { status: res.status, message: res.statusText, body: errBody };`);
    lines.push(`      throw err;`);
    lines.push(`    }`);
    lines.push(`    const text = await res.text();`);
    lines.push(`    return text ? JSON.parse(text) as T : undefined as unknown as T;`);
    lines.push(`  }`, ``);
  }

  // Generate methods
  let methodCount = 0;
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of httpMethods) {
      const operation = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!operation) continue;

      methodCount++;
      const opId = operation.operationId ?? toCamelCase(`${method}_${pathStr.replace(/[/{}_]/g, "_")}`);
      const params = operation.parameters ?? [];
      const pathParams = params.filter((p) => p.in === "path");
      const queryParams = params.filter((p) => p.in === "query");
      const hasBody = operation.requestBody && ["post", "put", "patch"].includes(method);

      // Build function args
      const args: string[] = [];
      for (const p of pathParams) {
        args.push(`${p.name}: string`);
      }
      if (queryParams.length > 0) {
        const fields = queryParams.map((p) => {
          const t = p.schema?.type === "integer" || p.schema?.type === "number" ? "number" : "string";
          return `${p.name}${p.required ? "" : "?"}: ${t}`;
        });
        args.push(`query: { ${fields.join("; ")} }`);
      }
      if (hasBody) {
        args.push(`body: unknown`);
      }

      // Return type — check 200 response
      const okResponse = operation.responses?.["200"] ?? operation.responses?.["201"];
      const returnType = "unknown";

      if (operation.summary) {
        lines.push(`  /** ${operation.summary} */`);
      }

      const argsStr = args.join(", ");
      lines.push(`  async ${toCamelCase(opId)}(${argsStr}): Promise<${returnType}> {`);

      // Build path with substitutions
      const builtPath = pathStr.replace(/\{([^}]+)\}/g, (_, name) => `\${${name}}`);
      const pathExpr = pathParams.length > 0 ? "`" + builtPath + "`" : `'${pathStr}'`;

      if (adapter === "fetch") {
        const queryArg = queryParams.length > 0
          ? `, Object.fromEntries(Object.entries(query).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)]))`
          : "";
        const bodyArg = hasBody ? `, body` : "";
        lines.push(`    return this.request<${returnType}>('${method.toUpperCase()}', ${pathExpr}${bodyArg}${queryArg});`);
      } else {
        const axiosArgs: string[] = [];
        if (queryParams.length > 0) axiosArgs.push(`params: query`);
        if (hasBody) axiosArgs.push(`data: body`);
        const configStr = axiosArgs.length > 0 ? `, { ${axiosArgs.join(", ")} }` : "";
        const dataMethod = hasBody ? `this.http.${method}<${returnType}>(${pathExpr}, body${configStr})` : `this.http.${method}<${returnType}>(${pathExpr}${configStr})`;
        lines.push(`    const res: AxiosResponse<${returnType}> = await ${dataMethod};`);
        lines.push(`    return res.data;`);
      }

      lines.push(`  }`, ``);
    }
  }

  lines.push(`}`);

  // Default export factory
  lines.push(``, `export function create${className}(config: ClientConfig): ${className} {`);
  lines.push(`  return new ${className}(config);`);
  lines.push(`}`);

  const defaultBase = options.baseUrl ?? spec.servers?.[0]?.url ?? "https://api.example.com";
  lines.push(``, `/** Pre-configured client with default base URL */`);
  lines.push(`export const defaultClient = new ${className}({ baseUrl: '${defaultBase}' });`);

  const output = options.output ?? "client.ts";
  writeOutput(lines.join("\n"), output);
  console.log(chalk.dim(`  ${methodCount} API methods generated (adapter: ${adapter})`));
}

// ─── Command: server ──────────────────────────────────────────────────────────

function cmdServer(specPath: string, options: { output?: string; framework?: string }): void {
  const spec = loadSpec(specPath);
  const framework = (options.framework ?? "express") as "express" | "fastify";
  const paths = spec.paths ?? {};
  const httpMethods = ["get", "post", "put", "patch", "delete"] as const;

  const lines: string[] = [
    `// Generated by openapi-gen-cli`,
    `// Source: ${basename(specPath)}`,
    `// Do not edit manually`,
    ``,
  ];

  if (framework === "express") {
    lines.push(`import { Router, Request, Response, NextFunction } from 'express';`, ``);
    lines.push(`const router = Router();`, ``);
  } else {
    lines.push(`import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';`, ``);
  }

  // Handler type
  if (framework === "express") {
    lines.push(`type Handler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;`, ``);
  } else {
    lines.push(`type Handler = (req: FastifyRequest, reply: FastifyReply) => void | Promise<void>;`, ``);
  }

  // Route handlers
  let routeCount = 0;
  const routeLines: string[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of httpMethods) {
      const operation = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!operation) continue;

      routeCount++;
      const opId = operation.operationId ?? toCamelCase(`${method}_${pathStr.replace(/[/{}_]/g, "_")}`);
      const handlerName = `${toCamelCase(opId)}Handler`;

      // Convert OpenAPI path params {id} to Express :id or Fastify :id
      const frameworkPath = pathStr.replace(/\{([^}]+)\}/g, ":$1");

      lines.push(`/**`);
      if (operation.summary) lines.push(` * ${operation.summary}`);
      lines.push(` * ${method.toUpperCase()} ${pathStr}`);
      lines.push(` */`);

      if (framework === "express") {
        lines.push(`export const ${handlerName}: Handler = async (req, res) => {`);
        lines.push(`  // TODO: implement ${opId}`);
        lines.push(`  res.status(200).json({ message: 'Not implemented' });`);
        lines.push(`};`, ``);
        routeLines.push(`router.${method}('${frameworkPath}', ${handlerName});`);
      } else {
        lines.push(`export const ${handlerName}: Handler = async (req, reply) => {`);
        lines.push(`  // TODO: implement ${opId}`);
        lines.push(`  reply.code(200).send({ message: 'Not implemented' });`);
        lines.push(`};`, ``);
        routeLines.push(`  fastify.${method}('${frameworkPath}', ${handlerName});`);
      }
    }
  }

  if (framework === "express") {
    lines.push(`// ─── Route registration ──────────────────────────────────────────────────────`);
    lines.push(...routeLines);
    lines.push(``);
    lines.push(`export { router };`);
  } else {
    lines.push(`// ─── Plugin registration ──────────────────────────────────────────────────────`);
    lines.push(`export async function registerRoutes(fastify: FastifyInstance): Promise<void> {`);
    lines.push(...routeLines);
    lines.push(`}`);
  }

  const output = options.output ?? "server.ts";
  writeOutput(lines.join("\n"), output);
  console.log(chalk.dim(`  ${routeCount} route handlers generated (framework: ${framework})`));
}

// ─── Command: validate ────────────────────────────────────────────────────────

interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

function cmdValidate(specPath: string, options: { strict?: boolean }): void {
  const spec = loadSpec(specPath);
  const issues: ValidationIssue[] = [];

  const add = (severity: "error" | "warning", path: string, message: string) => {
    issues.push({ severity, path, message });
  };

  // 1. Basic structure
  if (!spec.openapi && !spec.swagger) {
    add("error", "root", "Missing `openapi` or `swagger` version field");
  }
  if (!spec.info?.title) add("error", "info.title", "Missing info.title");
  if (!spec.info?.version) add("error", "info.version", "Missing info.version");

  // 2. Paths validation
  const paths = spec.paths ?? {};
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathStr.startsWith("/")) {
      add("error", `paths.${pathStr}`, `Path must start with "/"`);
    }

    const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"];
    for (const method of httpMethods) {
      const operation = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!operation) continue;

      const opPath = `paths.${pathStr}.${method}`;

      if (!operation.operationId) {
        add("warning", opPath, "Missing operationId");
      }

      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        add("error", opPath, "Operation has no responses defined");
      }

      // Check path params match
      const pathParamsInPath = [...pathStr.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const pathParamsInOp = (operation.parameters ?? [])
        .filter((p) => p.in === "path")
        .map((p) => p.name);

      for (const p of pathParamsInPath) {
        if (!pathParamsInOp.includes(p)) {
          add("error", `${opPath}.parameters`, `Path param {${p}} not defined in parameters`);
        }
      }

      if (options.strict) {
        if (!operation.summary) add("warning", opPath, "Missing summary");
        if (!operation.tags || operation.tags.length === 0) {
          add("warning", opPath, "No tags assigned to operation");
        }
      }
    }
  }

  // 3. Schema validation & circular reference detection
  const schemas = getSchemas(spec);
  const allRefNames = new Set<string>();

  function collectRefs(schema: SchemaObject | RefObject | undefined, visited = new Set<string>()): void {
    if (!schema) return;
    if ("$ref" in schema) {
      const name = schema.$ref.split("/").pop() ?? "";
      allRefNames.add(name);
      if (visited.has(name)) {
        add("error", `components.schemas.${name}`, `Circular reference detected: ${[...visited, name].join(" → ")}`);
        return;
      }
      const resolved = resolveRef(schema.$ref, spec);
      if (resolved) {
        collectRefs(resolved, new Set([...visited, name]));
      } else {
        add("error", `components.schemas`, `Unresolvable $ref: ${schema.$ref}`);
      }
      return;
    }
    const s = schema as SchemaObject;
    if (s.properties) Object.values(s.properties).forEach((p) => collectRefs(p, visited));
    if (s.items) collectRefs(s.items, visited);
    if (s.allOf) s.allOf.forEach((v) => collectRefs(v, visited));
    if (s.oneOf) s.oneOf.forEach((v) => collectRefs(v, visited));
    if (s.anyOf) s.anyOf.forEach((v) => collectRefs(v, visited));
    if (s.additionalProperties && typeof s.additionalProperties !== "boolean") {
      collectRefs(s.additionalProperties, visited);
    }
  }

  // Collect all refs from paths
  for (const pathItem of Object.values(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op) continue;
      if (op.requestBody?.content) {
        for (const media of Object.values(op.requestBody.content)) {
          if (media.schema) collectRefs(media.schema as SchemaObject, new Set());
        }
      }
      for (const resp of Object.values(op.responses ?? {})) {
        if (resp.content) {
          for (const media of Object.values(resp.content)) {
            if (media.schema) collectRefs(media.schema as SchemaObject, new Set());
          }
        }
      }
    }
  }

  // Check for schemas defined but never referenced
  if (options.strict) {
    for (const name of Object.keys(schemas)) {
      if (!allRefNames.has(name)) {
        add("warning", `components.schemas.${name}`, `Schema "${name}" is defined but never referenced`);
      }
    }
  }

  // ─── Report ───────────────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (issues.length === 0) {
    console.log(chalk.green("✓") + " Spec is valid — no issues found");
    return;
  }

  for (const issue of errors) {
    console.log(chalk.red("✗ [error]") + chalk.dim(` ${issue.path}`) + ` — ${issue.message}`);
  }
  for (const issue of warnings) {
    console.log(chalk.yellow("⚠ [warn] ") + chalk.dim(` ${issue.path}`) + ` — ${issue.message}`);
  }

  console.log(
    `\n${errors.length > 0 ? chalk.red(`${errors.length} error(s)`) : chalk.green("0 errors")}` +
    `, ${warnings.length > 0 ? chalk.yellow(`${warnings.length} warning(s)`) : chalk.green("0 warnings")}`
  );

  if (errors.length > 0) process.exit(1);
}

// ─── Command: diff ────────────────────────────────────────────────────────────

interface DiffChange {
  type: "breaking" | "non-breaking";
  description: string;
}

function cmdDiff(oldSpecPath: string, newSpecPath: string, options: { format?: string }): void {
  const oldSpec = loadSpec(oldSpecPath);
  const newSpec = loadSpec(newSpecPath);
  const changes: DiffChange[] = [];

  const add = (type: "breaking" | "non-breaking", description: string) => {
    changes.push({ type, description });
  };

  // Info changes
  if (oldSpec.info?.version !== newSpec.info?.version) {
    add("non-breaking", `Version changed: ${oldSpec.info?.version} → ${newSpec.info?.version}`);
  }

  // Servers
  const oldServers = new Set((oldSpec.servers ?? []).map((s) => s.url));
  const newServers = new Set((newSpec.servers ?? []).map((s) => s.url));
  for (const url of oldServers) {
    if (!newServers.has(url)) add("breaking", `Server removed: ${url}`);
  }
  for (const url of newServers) {
    if (!oldServers.has(url)) add("non-breaking", `Server added: ${url}`);
  }

  // Paths
  const oldPaths = oldSpec.paths ?? {};
  const newPaths = newSpec.paths ?? {};
  const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

  for (const [pathStr, oldItem] of Object.entries(oldPaths)) {
    if (!(pathStr in newPaths)) {
      add("breaking", `Path removed: ${pathStr}`);
      continue;
    }
    const newItem = newPaths[pathStr];

    for (const method of httpMethods) {
      const oldOp = (oldItem as Record<string, unknown>)[method] as OperationObject | undefined;
      const newOp = (newItem as Record<string, unknown>)[method] as OperationObject | undefined;

      if (oldOp && !newOp) {
        add("breaking", `Operation removed: ${method.toUpperCase()} ${pathStr}`);
        continue;
      }
      if (!oldOp && newOp) {
        add("non-breaking", `Operation added: ${method.toUpperCase()} ${pathStr}`);
        continue;
      }
      if (!oldOp || !newOp) continue;

      const opKey = `${method.toUpperCase()} ${pathStr}`;

      // Required params removed/added
      const oldRequired = new Set((oldOp.parameters ?? []).filter((p) => p.required).map((p) => `${p.in}:${p.name}`));
      const newRequired = new Set((newOp.parameters ?? []).filter((p) => p.required).map((p) => `${p.in}:${p.name}`));
      for (const p of oldRequired) {
        if (!newRequired.has(p)) add("breaking", `${opKey}: Required param removed: ${p}`);
      }
      for (const p of newRequired) {
        if (!oldRequired.has(p)) add("breaking", `${opKey}: New required param added: ${p}`);
      }

      // All params removed
      const oldParams = new Set((oldOp.parameters ?? []).map((p) => `${p.in}:${p.name}`));
      const newParams = new Set((newOp.parameters ?? []).map((p) => `${p.in}:${p.name}`));
      for (const p of oldParams) {
        if (!newParams.has(p)) add("non-breaking", `${opKey}: Param removed: ${p}`);
      }
      for (const p of newParams) {
        if (!oldParams.has(p)) add("non-breaking", `${opKey}: Param added: ${p}`);
      }

      // Response codes removed
      const oldCodes = new Set(Object.keys(oldOp.responses ?? {}));
      const newCodes = new Set(Object.keys(newOp.responses ?? {}));
      for (const code of oldCodes) {
        if (!newCodes.has(code)) add("non-breaking", `${opKey}: Response ${code} removed`);
      }

      // RequestBody required change
      if (oldOp.requestBody?.required === false && newOp.requestBody?.required === true) {
        add("breaking", `${opKey}: requestBody changed from optional to required`);
      }
      if (oldOp.requestBody && !newOp.requestBody) {
        add("breaking", `${opKey}: requestBody removed`);
      }

      // OperationId change
      if (oldOp.operationId && newOp.operationId && oldOp.operationId !== newOp.operationId) {
        add("breaking", `${opKey}: operationId changed: ${oldOp.operationId} → ${newOp.operationId}`);
      }
    }
  }

  for (const pathStr of Object.keys(newPaths)) {
    if (!(pathStr in oldPaths)) {
      add("non-breaking", `Path added: ${pathStr}`);
    }
  }

  // Schema changes
  const oldSchemas = getSchemas(oldSpec);
  const newSchemas = getSchemas(newSpec);
  for (const name of Object.keys(oldSchemas)) {
    if (!(name in newSchemas)) add("breaking", `Schema removed: ${name}`);
  }
  for (const name of Object.keys(newSchemas)) {
    if (!(name in oldSchemas)) add("non-breaking", `Schema added: ${name}`);
  }

  // ─── Report ───────────────────────────────────────────────────────────────
  if (changes.length === 0) {
    console.log(chalk.green("✓") + " No differences detected between specs");
    return;
  }

  const breaking = changes.filter((c) => c.type === "breaking");
  const nonBreaking = changes.filter((c) => c.type !== "breaking");

  if (options.format === "json") {
    console.log(JSON.stringify({ breaking, nonBreaking }, null, 2));
    return;
  }

  if (breaking.length > 0) {
    console.log(chalk.red.bold(`\nBreaking changes (${breaking.length}):`));
    for (const c of breaking) {
      console.log(chalk.red("  ✗ ") + c.description);
    }
  }
  if (nonBreaking.length > 0) {
    console.log(chalk.yellow.bold(`\nNon-breaking changes (${nonBreaking.length}):`));
    for (const c of nonBreaking) {
      console.log(chalk.yellow("  ~ ") + c.description);
    }
  }

  console.log(
    `\n${breaking.length > 0 ? chalk.red(`${breaking.length} breaking`) : chalk.green("0 breaking")}` +
    `, ${chalk.yellow(`${nonBreaking.length} non-breaking`)}`
  );

  if (breaking.length > 0) process.exit(1);
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("openapi-gen")
  .description("Generate TypeScript clients, server stubs, and types from OpenAPI specs")
  .version("1.0.0");

program
  .command("types <spec>")
  .description("Generate TypeScript interfaces from OpenAPI schema components")
  .option("-o, --output <file>", "Output file path", "types.ts")
  .option("--prefix <prefix>", "Prefix all generated type names", "")
  .action((spec: string, opts) => cmdTypes(spec, opts));

program
  .command("client <spec>")
  .description("Generate a typed HTTP client from spec endpoints")
  .option("-o, --output <file>", "Output file path", "client.ts")
  .option("--adapter <adapter>", "HTTP adapter to use: fetch or axios", "fetch")
  .option("--base-url <url>", "Override default base URL from spec")
  .action((spec: string, opts) => cmdClient(spec, opts));

program
  .command("server <spec>")
  .description("Generate Express/Fastify route handlers from spec")
  .option("-o, --output <file>", "Output file path", "server.ts")
  .option("--framework <framework>", "Server framework: express or fastify", "express")
  .action((spec: string, opts) => cmdServer(spec, opts));

program
  .command("validate <spec>")
  .description("Deep validation with semantic checks (circular refs, unused schemas)")
  .option("--strict", "Enable strict checks (missing summaries, unused schemas)", false)
  .action((spec: string, opts) => cmdValidate(spec, opts));

program
  .command("diff <old> <new>")
  .description("Compare two specs and report breaking/non-breaking changes")
  .option("--format <format>", "Output format: text or json", "text")
  .action((oldSpec: string, newSpec: string, opts) => cmdDiff(oldSpec, newSpec, opts));

program.parse(process.argv);
