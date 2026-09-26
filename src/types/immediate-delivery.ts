/**
 * What the server writes into a session's log when a message is delivered
 * into the turn already running rather than left for the next one.
 *
 *   `input:delivered { inboxId, reservationId, items, sentSeq?, status, reason?, detail? }`
 *       what the provider did with the batch, written as soon as it answers.
 *       `status` is the provider's answer and nothing more: `delivered` means
 *       it acknowledged this exact batch, and nothing here claims the model
 *       read, understood or acted on it.
 *   `input:incorporated { reservationId, where, evidence, late? }`
 *       later, when a turn actually takes the batch. `mid-turn` is the turn
 *       that was running when it was sent; `next-turn` is the one after,
 *       because that turn ended first. `late` marks one that resolved a batch
 *       already recorded as unacknowledged.
 *
 * The pair exists because acceptance and incorporation are different facts
 * and only the second is a delivery to the model. Claude acknowledges a
 * queued message in milliseconds, before any turn has been given it.
 */

export const INPUT_DELIVERED_EVENT = 'input:delivered';
export const INPUT_INCORPORATED_EVENT = 'input:incorporated';

/**
 * `delivered`: the provider acknowledged the batch. `rejected`: it refused,
 * and the rows are back in the inbox for an ordinary turn boundary.
 * `uncertain`: the batch was handed over and never acknowledged, so the rows
 * stay reserved and no one may send them again.
 */
export type ImmediateDeliveryStatus = 'delivered' | 'rejected' | 'uncertain';

export interface InputDeliveredData {
  inboxId: string;
  reservationId: string;
  items: number;
  /** The `input:sent` that carried the batch, when the provider's answer said. */
  sentSeq?: number;
  status: ImmediateDeliveryStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface InputIncorporatedData {
  reservationId: string;
  where: 'mid-turn' | 'next-turn';
  evidence: string;
  /** The batch had already been recorded as unacknowledged when this arrived. */
  late?: boolean;
}
