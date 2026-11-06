// Browser-safe subset (pure functions only): the order form runs the SAME validation and the SAME status table as the server for early
// feedback. The server recomputes everything and is the only authority.
export {
  CHANNEL_LABEL,
  OPEN_STATUSES,
  ORDER_CHANNELS,
  ORDER_STATUSES,
  STATUS_LABEL,
  TRANSITIONS,
  canTransition,
  isEditable,
  needsReason,
  type OrderChannel,
  type OrderStatus,
} from './states.js';
export { lineTotal, sumAmounts } from './money.js';
export {
  MAX_LINES,
  MAX_NOTE,
  confirmationProblems,
  validateOrder,
  type Address,
  type NormalizedOrder,
  type OrderLineInput,
  type Problem,
} from './validate.js';
