// A small JSON Schema validator for the KER schemas (draft 2020-12 subset): type (with null and
// integer), const, enum, pattern, minimum, maxLength, required, properties, items. Unknown
// fields pass, so readers stay tolerant (KERB-V2 5.1).

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/**
 * @returns {string[]} problems, empty when valid
 */
export function validate(schema, value, at = '$') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  if ('const' in schema && value !== schema.const) out.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) { out.push(`${at}: must be ${types.join(' or ')} (got ${t})`); return out; }
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: does not match ${schema.pattern}`);
    if (schema.maxLength != null && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${at}: missing ${k}`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) out.push(...validate(sub, value[k], `${at}.${k}`));
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, `${at}[${i}]`)));
  return out;
}
