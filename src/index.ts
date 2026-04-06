import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

interface OpenAPIServer {
  url: string;
  description?: string;
}

interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchemaProperty>;
  required?: string[];
  allOf?: OpenAPISchemaRef[];
  oneOf?: OpenAPISchemaRef[];
  anyOf?: OpenAPISchemaRef[];
  description?: string;
}

interface OpenAPISchemaProperty {
  type: string;
  description?: string;
  format?: string;
  example?: unknown;
}

interface OpenAPISchemaRef {
  $ref: string;
}

interface OpenAPIComponents {
  schemas: Record<string, OpenAPISchema>;
}

interface OpenAPIParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema: { type: string };
  description?: string;
}

interface OpenAPIRequestBody {
  required: boolean;
  content: {
    "application/json": {
      schema: OpenAPISchemaRef;
    };
  };
}

interface OpenAPIResponse {
  description: string;
  content?: {
    "application/json": {
      schema: OpenAPISchemaRef | OpenAPISchema;
    };
  };
}

interface OpenAPIOperation {
  operationId: string;
  tags: string[];
  summary: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
}

interface OpenAPIPath {
  [method: string]: OpenAPIOperation;
}

interface OpenAPISpec {
  openapi: string;
  info: OpenAPIInfo;
  servers: OpenAPIServer[];
  paths: Record<string, OpenAPIPath>;
  components: OpenAPIComponents;
}

// ─── YAML serializer (no deps) ───────────────────────────────────────────────

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null || value === undefined) return "null";

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    // Multi-line strings
    if (value.includes("\n")) {
      const lines = value.split("\n");
      return "|\n" + lines.map((l) => pad + "  " + l).join("\n");
    }
    // Strings that need quoting
    if (
      /[:{}\[\],&*#?|<>=!%@`]/.test(value) ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value === "" ||
      /^(true|false|null|yes|no|on|off|\d+\.?\d*)$/i.test(value)
    ) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          // Render at indent=0, then re-indent relative to current position.
          const rendered = toYaml(item, 0);
          const lines = rendered.split("\n");
          const first = `${pad}- ${lines[0]}`;
          const rest = lines.slice(1).map((l) => `${pad}  ${l}`);
          return rest.length > 0 ? `${first}\n${rest.join("\n")}` : first;
        }
        return `${pad}- ${toYaml(item, 0)}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys
      .map((key) => {
        const v = obj[key];
        const safeKey =
          /[:{}\[\],&*#?|<>=!%@`\s]/.test(key) ? `"${key}"` : key;
        if (
          typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          Object.keys(v).length > 0
        ) {
          return `${pad}${safeKey}:\n${toYaml(v, indent + 1)}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `${pad}${safeKey}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${safeKey}: ${toYaml(v, indent + 1)}`;
      })
      .join("\n");
  }

  return String(value);
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const DEFAULT_FILE = "openapi.yaml";

function resolveFile(file: string): string {
  return resolve(process.cwd(), file);
}

function readSpec(file: string): OpenAPISpec {
  const path = resolveFile(file);
  if (!existsSync(path)) {
    console.error(chalk.red(`File not found: ${path}`));
    console.error(chalk.yellow('Run `openapi-gen init` first.'));
    process.exit(1);
  }
  try {
    // Parse YAML manually (no deps) — we only need to re-read what we wrote,
    // so we serialise/deserialise via JSON round-trip through our own writer.
    // Since we own the format we use a simple re-parse via eval-safe JSON trick:
    // Actually we'll keep the spec in memory by re-reading the raw YAML we wrote.
    // For simplicity, store a JSON sidecar alongside the YAML.
    const jsonPath = path.replace(/\.ya?ml$/, ".json");
    if (!existsSync(jsonPath)) {
      console.error(
        chalk.red(
          `JSON sidecar not found: ${jsonPath}. Was the spec created with this tool?`
        )
      );
      process.exit(1);
    }
    return JSON.parse(readFileSync(jsonPath, "utf8")) as OpenAPISpec;
  } catch (e) {
    console.error(chalk.red(`Failed to read spec: ${(e as Error).message}`));
    process.exit(1);
  }
}

function writeSpec(spec: OpenAPISpec, file: string): void {
  const yamlPath = resolveFile(file);
  const jsonPath = yamlPath.replace(/\.ya?ml$/, ".json");

  const yaml = "# Generated by openapi-gen-cli\n" + toYaml(spec) + "\n";
  writeFileSync(yamlPath, yaml, "utf8");
  writeFileSync(jsonPath, JSON.stringify(spec, null, 2), "utf8");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
}

function methodColor(method: string): string {
  const m = method.toUpperCase();
  const colors: Record<string, (s: string) => string> = {
    GET: chalk.green,
    POST: chalk.blue,
    PUT: chalk.yellow,
    PATCH: chalk.cyan,
    DELETE: chalk.red,
  };
  return (colors[m] ?? chalk.white)(m);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdInit(options: { output: string; title: string; apiVersion: string; server: string }): void {
  const path = resolveFile(options.output);
  if (existsSync(path)) {
    console.error(chalk.yellow(`File already exists: ${path}`));
    console.error(chalk.yellow("Use --output to specify a different filename."));
    process.exit(1);
  }

  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info: {
      title: options.title,
      version: options.apiVersion,
      description: "API description",
    },
    servers: [
      {
        url: options.server,
        description: "Default server",
      },
    ],
    paths: {},
    components: {
      schemas: {},
    },
  };

  writeSpec(spec, options.output);
  console.log(chalk.green("✓") + ` Created ${chalk.bold(path)}`);
  console.log(
    chalk.dim(
      `  openapi: 3.0.3 | title: ${options.title} | version: ${options.apiVersion}`
    )
  );
}

function cmdEndpoint(
  method: string,
  path: string,
  options: {
    output: string;
    tag: string;
    operationId?: string;
    summary?: string;
    param?: string[];
    noBody: boolean;
    bodySchema?: string;
  }
): void {
  const m = method.toLowerCase();
  const allowedMethods = ["get", "post", "put", "patch", "delete", "head", "options"];
  if (!allowedMethods.includes(m)) {
    console.error(chalk.red(`Invalid method: ${method}`));
    console.error(chalk.dim(`Allowed: ${allowedMethods.join(", ")}`));
    process.exit(1);
  }

  if (!path.startsWith("/")) {
    console.error(chalk.red(`Path must start with "/": ${path}`));
    process.exit(1);
  }

  const spec = readSpec(options.output);

  if (!spec.paths[path]) {
    spec.paths[path] = {};
  }

  if (spec.paths[path][m]) {
    console.error(
      chalk.yellow(`Endpoint ${methodColor(m)} ${path} already exists — overwriting.`)
    );
  }

  // Derive operationId from method + path if not provided
  const operationId =
    options.operationId ??
    slugify(`${m}_${path.replace(/\//g, "_").replace(/[{}]/g, "")}`);

  // Extract path parameters from path template {param}
  const pathParamNames = [...path.matchAll(/\{([^}]+)\}/g)].map((r) => r[1]);

  const parameters: OpenAPIParameter[] = pathParamNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `${name} path parameter`,
  }));

  // Additional query params from --param name:type
  for (const p of options.param ?? []) {
    const [pName, pType = "string"] = p.split(":");
    parameters.push({
      name: pName,
      in: "query",
      required: false,
      schema: { type: pType },
      description: `${pName} query parameter`,
    });
  }

  const hasBody = !options.noBody && ["post", "put", "patch"].includes(m);

  const operation: OpenAPIOperation = {
    operationId,
    tags: [options.tag],
    summary: options.summary ?? `${method.toUpperCase()} ${path}`,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(hasBody
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: options.bodySchema
                  ? { $ref: `#/components/schemas/${options.bodySchema}` }
                  : { $ref: "#/components/schemas/RequestBody" },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Successful response",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Response" },
          },
        },
      },
      "400": {
        description: "Bad request",
      },
      "401": {
        description: "Unauthorized",
      },
      "500": {
        description: "Internal server error",
      },
    },
  };

  spec.paths[path][m] = operation;

  writeSpec(spec, options.output);

  console.log(
    chalk.green("✓") +
      ` Added ${methodColor(m)} ${chalk.bold(path)} → operationId: ${chalk.cyan(operationId)}`
  );
  if (parameters.length > 0) {
    console.log(chalk.dim(`  parameters: ${parameters.map((p) => p.name).join(", ")}`));
  }
  if (hasBody) {
    console.log(chalk.dim(`  requestBody: application/json`));
  }
}

function cmdComponent(
  name: string,
  options: {
    output: string;
    type: string;
    property?: string[];
    required?: string[];
    allOf?: string[];
    oneOf?: string[];
    anyOf?: string[];
    description?: string;
  }
): void {
  const spec = readSpec(options.output);

  if (spec.components.schemas[name]) {
    console.error(chalk.yellow(`Component "${name}" already exists — overwriting.`));
  }

  const properties: Record<string, OpenAPISchemaProperty> = {};

  for (const prop of options.property ?? []) {
    // format: name:type[:description]
    const parts = prop.split(":");
    const pName = parts[0];
    const pType = parts[1] ?? "string";
    const pDesc = parts.slice(2).join(":");
    properties[pName] = {
      type: pType,
      ...(pDesc ? { description: pDesc } : {}),
    };
  }

  const toRef = (r: string): OpenAPISchemaRef => ({
    $ref: `#/components/schemas/${r}`,
  });

  const schema: OpenAPISchema = {
    type: options.type,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(options.required && options.required.length > 0
      ? { required: options.required }
      : {}),
    ...(options.allOf && options.allOf.length > 0
      ? { allOf: options.allOf.map(toRef) }
      : {}),
    ...(options.oneOf && options.oneOf.length > 0
      ? { oneOf: options.oneOf.map(toRef) }
      : {}),
    ...(options.anyOf && options.anyOf.length > 0
      ? { anyOf: options.anyOf.map(toRef) }
      : {}),
    ...(options.description ? { description: options.description } : {}),
  };

  spec.components.schemas[name] = schema;

  writeSpec(spec, options.output);

  console.log(
    chalk.green("✓") +
      ` Added component ${chalk.bold(name)} (type: ${chalk.cyan(options.type)})`
  );
  if (Object.keys(properties).length > 0) {
    console.log(
      chalk.dim(`  properties: ${Object.keys(properties).join(", ")}`)
    );
  }
  if (options.required && options.required.length > 0) {
    console.log(chalk.dim(`  required: ${options.required.join(", ")}`));
  }
  const compositions = [
    ...(options.allOf ?? []).map((r) => `allOf:${r}`),
    ...(options.oneOf ?? []).map((r) => `oneOf:${r}`),
    ...(options.anyOf ?? []).map((r) => `anyOf:${r}`),
  ];
  if (compositions.length > 0) {
    console.log(chalk.dim(`  composition: ${compositions.join(", ")}`));
  }
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("openapi-gen")
  .description("Generate and manage OpenAPI 3.0 specifications")
  .version("1.0.0");

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("Create an OpenAPI 3.0 YAML template")
  .option("-o, --output <file>", "Output filename", DEFAULT_FILE)
  .option("-t, --title <title>", "API title", "My API")
  .option("-v, --api-version <version>", "API version", "1.0.0")
  .option("-s, --server <url>", "Server URL", "https://api.example.com/v1")
  .action((opts) => cmdInit(opts));

// ── endpoint ──────────────────────────────────────────────────────────────────
program
  .command("endpoint <method> <path>")
  .description("Add an endpoint to the spec")
  .option("-o, --output <file>", "Spec filename", DEFAULT_FILE)
  .option("--tag <tag>", "Tag for the endpoint", "default")
  .option("--operation-id <id>", "Custom operationId")
  .option("--summary <summary>", "Short summary")
  .option(
    "--param <name:type>",
    "Add a query parameter (repeatable, e.g. --param page:integer)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--no-body", "Skip requestBody (even for POST/PUT/PATCH)")
  .option("--body-schema <name>", "Reference an existing schema for requestBody")
  .action((method: string, path: string, opts) =>
    cmdEndpoint(method, path, opts)
  );

// ── component ─────────────────────────────────────────────────────────────────
program
  .command("component <name>")
  .description("Add a schema component to components/schemas")
  .option("-o, --output <file>", "Spec filename", DEFAULT_FILE)
  .option("--type <type>", "Schema type (object, string, integer, …)", "object")
  .option(
    "--property <name:type[:desc]>",
    "Add a property (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--required <name>",
    "Mark a property as required (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--all-of <schema>",
    "Add allOf reference (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--one-of <schema>",
    "Add oneOf reference (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--any-of <schema>",
    "Add anyOf reference (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--description <text>", "Schema description")
  .action((name: string, opts) => cmdComponent(name, opts));

program.parse(process.argv);
