import { resolveBusinessDocument } from '../../fiscal-core/src/business-document.mjs';
import { serializeBusinessDocument } from './business-serializer.mjs';

/** Legacy entry point: revalidates content and explicit test identity. Never accepts a pre-resolved object. */
export function buildBusinessXml(input) {
  return serializeBusinessDocument(resolveBusinessDocument(input));
}
