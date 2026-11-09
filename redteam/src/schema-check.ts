/** Checks JSON values against the subset of JSON Schema draft 2020-12 these files use. */

interface Schema {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, Schema>>;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly type?: string | readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly minimum?: number;
  readonly minLength?: number;
  readonly pattern?: string;
}

export function assertSchema(value: unknown, schema: Schema, label = 'value'): void {
  check(value, schema, schema, label);
}

function check(value: unknown, schema: Schema, root: Schema, label: string): void {
  if (schema.$ref !== undefined) {
    check(value, resolveRef(schema.$ref, root), root, label);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${label} must be ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    throw new Error(`${label} is not in the enum.`);
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    throw new Error(`${label} has the wrong type.`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    throw new Error(`${label} is shorter than ${schema.minLength}.`);
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    throw new Error(`${label} does not match ${schema.pattern}.`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`${label} is below ${schema.minimum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${label} has fewer than ${schema.minItems} items.`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => check(entry, schema.items as Schema, root, `${label}[${index}]`));
    }
  }
  if (isObject(value)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) throw new Error(`${label}.${key} is required.`);
    }
    if (schema.properties !== undefined) {
      for (const [key, child] of Object.entries(value)) {
        const childSchema = schema.properties[key];
        if (childSchema === undefined) {
          if (schema.additionalProperties === false) throw new Error(`${label}.${key} is not allowed.`);
          continue;
        }
        check(child, childSchema, root, `${label}.${key}`);
      }
    }
  }
}

function resolveRef(ref: string, root: Schema): Schema {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported $ref ${ref}.`);
  const name = ref.slice(prefix.length);
  const found = root.$defs?.[name];
  if (found === undefined) throw new Error(`Missing $ref ${ref}.`);
  return found;
}

function typeMatches(value: unknown, type: string | readonly string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => {
    if (entry === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (entry === 'null') return value === null;
    if (entry === 'array') return Array.isArray(value);
    if (entry === 'object') return isObject(value);
    return typeof value === entry;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
