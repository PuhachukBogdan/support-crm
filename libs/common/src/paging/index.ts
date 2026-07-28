/**
 * Keyset paging (feature 018, roadmap 5.1).
 *
 * An explicit named re-export rather than `export *`: a barrel that forwards a wildcard silently
 * resolves a missing name to `undefined` at the consumer, which is the trap the proto barrels already
 * documented the hard way.
 */
export {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_PAGE_SIZE,
  type Cursor,
} from './keyset';
