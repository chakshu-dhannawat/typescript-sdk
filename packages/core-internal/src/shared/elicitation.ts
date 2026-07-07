import { ProtocolErrorCode } from '../types/enums';
import { ProtocolError } from '../types/errors';
import {
    BooleanSchemaSchema,
    ElicitRequestFormParamsSchema,
    LegacyTitledEnumSchemaSchema,
    NumberSchemaSchema,
    PrimitiveSchemaDefinitionSchema,
    StringSchemaSchema,
    TitledMultiSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    UntitledMultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema
} from '../types/schemas';
import type { ElicitRequestFormParams, StringSchema } from '../types/types';
import { parseSchema, shapeKeys } from '../util/schema';
import type { StandardSchemaWithJSON } from '../util/standardSchema';
import { isLibraryFormatPattern, isStandardSchema, standardSchemaToJsonSchema } from '../util/standardSchema';

/**
 * Input accepted by `inputRequired.elicit()`: a wire-ready elicitation JSON Schema, or a
 * Standard Schema (e.g. a Zod object) converted to the restricted wire shape at build time.
 */
export type ElicitInputParams = Omit<ElicitRequestFormParams, 'requestedSchema'> & {
    requestedSchema: ElicitRequestFormParams['requestedSchema'] | StandardSchemaWithJSON;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertStandardElicitationSchema(schema: StandardSchemaWithJSON): Record<string, unknown> {
    try {
        return standardSchemaToJsonSchema(schema, 'input');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`
        );
    }
}

// JSON Schema metadata-vocabulary keywords carry no validation semantics, so positions
// that cannot carry them on the wire may drop them silently. `title`/`description` are
// wire-supported wherever the grammar below lists them; this set only decides the fate
// of the positions that don't.
const ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = new Set([
    '$comment',
    'deprecated',
    'description',
    'examples',
    'readOnly',
    'title',
    'writeOnly'
]);

function isAnnotationOnlyJsonSchemaKeyword(key: string): boolean {
    return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-');
}

/*
 * The wire grammar, derived from the wire schemas so it tracks spec revisions.
 * The walk below decides each key's fate against it (keep / drop / reject with path);
 * value validity stays owned by the wire schemas themselves.
 */

// `$schema` is spec-declared on the root but reaches the wire type via its catchall.
const ROOT_KEYS = new Set(['$schema', ...Object.keys(ElicitRequestFormParamsSchema.shape.requestedSchema.shape)]);

const PROPERTY_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
    string: shapeKeys([
        StringSchemaSchema,
        UntitledSingleSelectEnumSchemaSchema,
        TitledSingleSelectEnumSchemaSchema,
        LegacyTitledEnumSchemaSchema
    ]),
    number: shapeKeys([NumberSchemaSchema]),
    integer: shapeKeys([NumberSchemaSchema]),
    boolean: shapeKeys([BooleanSchemaSchema]),
    array: shapeKeys([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema])
};

const SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set(StringSchemaSchema.shape.format.unwrap().options);

/** Walks one property node: keeps grammar keys, drops the library format pattern, rejects unknown constraints. */
function walkProperty(node: unknown, path: string, vendor: string, unsupported: string[]): unknown {
    if (!isJsonObject(node)) {
        return node;
    }
    const allowedKeys = typeof node.type === 'string' ? PROPERTY_KEYS_BY_TYPE[node.type] : undefined;
    if (allowedKeys === undefined) {
        // Unknown `type` — value validation rejects the node and names it.
        return node;
    }

    const pruned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (allowedKeys.has(key) || isAnnotationOnlyJsonSchemaKeyword(key)) {
            // Annotations in positions the wire cannot carry are stripped by value
            // validation and excused below; supported ones ride through it untouched.
            pruned[key] = value;
        } else if (key === 'pattern' && node.type === 'string' && typeof node.format === 'string') {
            if (!SUPPORTED_STRING_FORMATS.has(node.format)) {
                pruned[key] = value; // the unsupported format itself fails value validation
            } else if (
                typeof value !== 'string' ||
                !isLibraryFormatPattern(node.format as NonNullable<StringSchema['format']>, value, vendor)
            ) {
                // The library's own format regex drops (format still rides the wire); a
                // customized pattern must not be silently weakened, so it rejects.
                unsupported.push(`${path}.${key}`);
            }
        } else {
            unsupported.push(`${path}.${key}`);
        }
    }
    return pruned;
}

/** Walks the schema root: keeps the spec root keys, drops annotations, rejects the rest. */
function walkRequestedSchema(converted: Record<string, unknown>, vendor: string): Record<string, unknown> {
    const pruned: Record<string, unknown> = {};
    const unsupported: string[] = [];
    for (const [key, value] of Object.entries(converted)) {
        if (key === 'properties' && isJsonObject(value)) {
            pruned[key] = Object.fromEntries(
                Object.entries(value).map(([name, node]) => [name, walkProperty(node, `properties.${name}`, vendor, unsupported)])
            );
        } else if (ROOT_KEYS.has(key)) {
            pruned[key] = value;
        } else if (!isAnnotationOnlyJsonSchemaKeyword(key)) {
            unsupported.push(key);
        }
    }
    if (unsupported.length > 0) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${unsupported.join(', ')}`
        );
    }
    return pruned;
}

/** Names the properties that fail value validation, instead of surfacing a raw union dump. */
function describeUnsupportedProperties(pruned: Record<string, unknown>, fallback: string): string {
    if (!isJsonObject(pruned.properties)) {
        return fallback;
    }
    const offenders = Object.entries(pruned.properties)
        .filter(([, node]) => !parseSchema(PrimitiveSchemaDefinitionSchema, node).success)
        .map(([name]) => `properties.${name}`);
    return offenders.length > 0 ? offenders.join(', ') : fallback;
}

// Safety net behind the walk: value validation strips keys no single wire shape can
// carry together (e.g. `format` beside `enum`); anything non-annotation it dropped is a
// constraint that must reject rather than silently weaken.
function findDroppedConstraintPaths(original: unknown, parsed: unknown, path = ''): string[] {
    if (Array.isArray(original) && Array.isArray(parsed)) {
        return original.flatMap((item, index) => findDroppedConstraintPaths(item, parsed[index], `${path}[${index}]`));
    }
    if (!isJsonObject(original) || !isJsonObject(parsed)) {
        return [];
    }
    return Object.entries(original).flatMap(([key, value]) => {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
            return isAnnotationOnlyJsonSchemaKeyword(key) ? [] : [childPath];
        }
        return findDroppedConstraintPaths(value, parsed[key], childPath);
    });
}

/** Converts an authoring-friendly elicitation input into its wire-ready form. */
export function normalizeElicitInputParams(input: ElicitInputParams): ElicitRequestFormParams {
    // Route on `~standard.validate`, not `~standard.jsonSchema`: zod 4.0/4.1 implements
    // only the former, and the converter owns the per-vendor fallback (see the same
    // decision in normalizeRawShapeSchema).
    if (!isStandardSchema(input.requestedSchema)) {
        return { ...input, mode: 'form', requestedSchema: input.requestedSchema };
    }

    const vendor = input.requestedSchema['~standard'].vendor;
    const pruned = walkRequestedSchema(convertStandardElicitationSchema(input.requestedSchema), vendor);

    // Value validity is owned by the wire schema; scoped to the converted schema so
    // params-level fields behave exactly as on the raw branch above.
    const parsed = parseSchema(ElicitRequestFormParamsSchema.shape.requestedSchema, pruned);
    if (!parsed.success) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${describeUnsupportedProperties(pruned, parsed.error.message)}`
        );
    }

    const droppedConstraints = findDroppedConstraintPaths(pruned, parsed.data);
    if (droppedConstraints.length > 0) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${droppedConstraints.join(', ')}`
        );
    }

    // Some converters lose exotic property names from `properties` while still listing
    // them in `required` (zod's toJSONSchema does for `__proto__`).
    const danglingRequired = (parsed.data.required ?? []).filter(key => !Object.prototype.hasOwnProperty.call(parsed.data.properties, key));
    if (danglingRequired.length > 0) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Elicitation requestedSchema lists required properties that are not defined in properties: ${danglingRequired.join(', ')}`
        );
    }

    return { ...input, mode: 'form', requestedSchema: parsed.data };
}
