/** What can be connected to what, and the ops that connect and disconnect them. */

import type { ConnectionRow, Op, Peer } from "../api/types.ts";

/** Classes two connection definitions have in common. */
export const shared = (a: string[], b: string[]) => a.filter((c) => b.includes(c));

/** The other ends a connection could be joined to: the opposite role, a class in common, on
 *  another device. An input takes one provider, so only free inputs are offered for an output;
 *  an output can feed several inputs, so any output is offered for an input. */
export function candidates(rows: ConnectionRow[], from: ConnectionRow): ConnectionRow[] {
  return rows.filter((r) =>
    r.device.id !== from.device.id
    && r.connection.role !== from.connection.role
    && shared(r.connection.classes, from.connection.classes).length > 0
    && (r.connection.role === "output" || r.connection.connected_to.length === 0));
}

export function connectOp(a: ConnectionRow, b: ConnectionRow): Op {
  const [consumer, provider] = a.connection.role === "input" ? [a, b] : [b, a];
  return {
    op: "add_connection",
    consumer_device: consumer.device.id,
    consumer_binding: consumer.connection.id,
    provider_device: provider.device.id,
    provider_binding: provider.connection.id,
    class: shared(consumer.connection.classes, provider.connection.classes)[0],
    consumer_name: consumer.connection.name,
  };
}

/** Disconnect `peer` from the connection `id` of `device`, whichever side is the consumer. */
export function disconnectOp(device: number, id: number, role: "input" | "output", peer: Peer): Op {
  const [consumer_device, consumer_binding] = role === "input" ? [device, id] : [peer.device.id, peer.binding];
  return { op: "remove_connection", consumer_device, consumer_binding, class: peer.classes[0] ?? "" };
}
