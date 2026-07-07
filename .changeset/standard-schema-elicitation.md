---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
---

Allow `inputRequired.elicit()` to accept a Standard Schema such as a Zod object for `requestedSchema`. The builder converts it to MCP's restricted form-elicitation JSON Schema, while the same schema can validate and type the response through `acceptedContent()` on handler re-entry. Zod string formats mapping to the supported `email`, `uri`, `date`, and `date-time` formats are accepted (the format-check regex zod emits beside them is dropped from the wire). Shapes the restricted schema cannot express reject before anything is sent: customized format patterns (`z.email({ pattern })`), arbitrary `.regex()` constraints, literal unions (use `z.enum` or `z.literal(['a', 'b'])` instead), nested objects, and non-spec root keywords such as the `additionalProperties` emitted by `z.strictObject()`.
