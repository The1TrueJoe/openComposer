/** Devices on the LAN versus the project: which ones aren't in it yet, and the identity
 *  Director should be given for one. Shared by Design › Add devices and the Network tab. */

import type { Announcement, NetworkView, PhysicalDevice } from "../api/types.ts";

/** Controllers announce themselves too; they're the Director, not something to add. */
export const isController = (deviceType: string) => deviceType.startsWith("c4:control4_") && !deviceType.includes("sr2");

/** What to identify a device as. Director binds by its own physical-device uuid when it has
 *  discovered the device itself; otherwise by the SDDP `<Type>-<Host>` it would make up. */
export function identityFor(a: Pick<Announcement, "address" | "host" | "device_type">, physical: PhysicalDevice[]) {
  const known = physical.find((p) => p.address === a.address);
  return { address: known?.uuid ?? `${a.device_type}-${a.host}`, search_type: a.device_type };
}

/** A device on the network that no project device is identified as. */
export interface Unidentified {
  address: string;
  device_type: string;
  /** From SDDP, when the live scan heard it. */
  host: string | null;
  manufacturer: string;
  model: string;
  /** The driver file the device names in its announcement, if any. */
  driver: string;
  /** What `add_driver`'s `identify` should be given. */
  identity: { address: string; search_type: string };
  /** Who saw it: Director, this computer's scan, or both. */
  seenBy: ("director" | "scan")[];
}

/** Director's "discovered, not in project" and a live scan, merged by IP address. Controllers
 *  and anything already identified are left out. */
/** Generic UPnP answers ("urn:schemas-upnp-org:device:…") to the SDDP query: routers, media
 *  renderers and the like that no Control4 driver identifies by. */
const isUpnp = (t: string) => t.toLowerCase().startsWith("urn:");

export function unidentified(net: NetworkView | undefined, scan: Announcement[] | undefined): Unidentified[] {
  const physical = net?.discovered ?? [];
  const bound = new Set((net?.identified ?? []).flatMap((x) => [x.uuid, x.address]).filter(Boolean));
  // Director has these and knows they're bound (they're discovered but not in the free list).
  const free = new Set((net?.discovered_not_in_project ?? []).map((p) => p.address));
  const boundIps = new Set(physical.filter((p) => !free.has(p.address)).map((p) => p.address));
  const out = new Map<string, Unidentified>();
  for (const p of net?.discovered_not_in_project ?? []) {
    if (isController(p.device_type) || isUpnp(p.device_type) || bound.has(p.uuid) || bound.has(p.address)) continue;
    out.set(p.address, { address: p.address, device_type: p.device_type, host: null, manufacturer: "", model: "", driver: "",
      identity: { address: p.uuid, search_type: p.device_type }, seenBy: ["director"] });
  }
  for (const a of scan ?? []) {
    if (isController(a.device_type) || isUpnp(a.device_type) || boundIps.has(a.address)) continue;
    const identity = identityFor(a, physical);
    if (bound.has(identity.address) || bound.has(a.host) || bound.has(a.address)) continue;
    const d = out.get(a.address);
    out.set(a.address, {
      address: a.address, device_type: a.device_type, host: a.host, manufacturer: a.manufacturer, model: a.model, driver: a.driver,
      identity, seenBy: d ? ["director", "scan"] : ["scan"],
    });
  }
  return [...out.values()].sort((x, y) => x.address.localeCompare(y.address, undefined, { numeric: true }));
}
