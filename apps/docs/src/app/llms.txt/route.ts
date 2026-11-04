import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;

// Generated from the Go types by tools/canette-schema, served from public/schema.
const SCHEMAS = `
## JSON Schemas

- [canette.yaml](https://canette.dev/schema/canette.json): every canette.yaml field with its type, allowed values and description
- [canette-template.yaml](https://canette.dev/schema/canette-template.json): the template file format, including the per-app canette.yaml fields
`;

export async function GET() {
  return new Response(`${(await llms(source).index()).trimEnd()}\n${SCHEMAS}`);
}
