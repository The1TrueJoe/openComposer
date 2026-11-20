//! Zigbee network management (Composer Pro's Network → Zigbee tools).
//!
//! The read side lives in [`crate::director::ZigbeeQuery`]: `GetZigbeeZserverInfo`,
//! `GetZigbeeMeshInfo`, `GetAllZigbeeNodes` and `GetZigbeeZaps`, each answered by an
//! event. This module is the *config* side — the actions that change the live mesh:
//! opening the join window to pair a device, dropping a node, and flashing an access
//! point so the installer can find it. They carry no project data, so, like
//! [`crate::ops::Op::SendCommand`], they change nothing in the snapshot and are approved
//! only because they act on real hardware.
//!
//! The controller's own Zigbee server is the device these go to (`iddevice`), the same id
//! the reads use (the Director's device id — 15 on the EA-3 test rig, 30 on a typical EA-1).
//!
//! What this module is NOT: the AP data plane. The zserver drives access points over a
//! separate protobuf protocol on TCP 7910 (a sibling project reimplements that); here we
//! only speak the Director's c4soap management plane, as Composer does.
//!
//! ponytail: the four `Get*` reads are confirmed, but the *write* method names and
//! parameters below could not be verified live — the EA-3 test rig has no paired Zigbee
//! devices (its zserver reads time out) and writing to a real mesh needs the owner's OK.
//! They are the best inference from Director's own naming (`Zigbee<Thing>` reads →
//! `<Verb>Zigbee<Thing>` writes) and Control4's public Zigbee docs. Each is gated behind
//! the approval path, so a wrong name errors harmlessly rather than doing damage. Confirm
//! them against a controller with a live mesh, then correct the `Call`s here — one place.

use serde::{Deserialize, Serialize};

use crate::soap::Call;

/// A Zigbee mesh management action. Closed set (not an arbitrary RPC) so every approval
/// card says exactly what will happen.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(tag = "zigbee", rename_all = "snake_case")]
pub enum ZigbeeAction {
    /// Open the mesh so a new device can join and be paired, for `seconds` (Composer's
    /// "Add Zigbee Device"). `0` closes the window again. After the device joins, bind it
    /// to its driver with an `add_network_binding` of type 3 — that half is a verified path.
    PermitJoin { seconds: u32 },
    /// Tell the Zigbee server to drop a node from the mesh by its Zigbee address (the node
    /// leaves; this is the mesh-side counterpart to removing the device's project identity).
    RemoveNode { address: String },
    /// Flash an access point's identify light so the installer can find it physically
    /// (Composer's "Identify" on an access point), by the AP's Zigbee address.
    IdentifyAccessPoint { address: String },
    /// Add a Zigbee access point by IP address. Unlike Composer's "Edit Zigbee Configuration"
    /// dropdown — which only offers controllers the Director already sees as Zigbee-radio
    /// hardware — this goes straight to the zserver's node broker, which dials the AP OUT over
    /// TCP 7910 at the given IP (the broker logs "AddZap with IP:" then connects to `<ip>:7910`).
    /// That IP path is how a standalone AP that the hardware list would never show gets added.
    AddAccessPoint { ip: String },
}

impl ZigbeeAction {
    /// The c4soap call(s) Composer would send for this action. See the module `ponytail`
    /// note: the method names are unverified against a live mesh.
    pub fn calls(&self, iddevice: u32) -> Vec<Call> {
        match self {
            // ponytail: unverified method + param names (see module note).
            Self::PermitJoin { seconds } => {
                vec![Call::new("SetZigbeePermitJoin").num("iddevice", iddevice).num("seconds", *seconds)]
            }
            Self::RemoveNode { address } => {
                vec![Call::new("RemoveZigbeeNode").num("iddevice", iddevice).str("address", address)]
            }
            Self::IdentifyAccessPoint { address } => {
                vec![Call::new("IdentifyZigbeeZap").num("iddevice", iddevice).str("address", address)]
            }
            // ponytail: method is the node-broker "AddZap"; the IP param name is inferred from
            // the broker's "AddZap with IP:" log line. Verify both against a live broker.
            Self::AddAccessPoint { ip } => {
                vec![Call::new("AddZap").num("iddevice", iddevice).str("ip", ip)]
            }
        }
    }

    /// One line for an approval card.
    pub fn describe(&self) -> String {
        match self {
            Self::PermitJoin { seconds: 0 } => "Close the Zigbee join window".into(),
            Self::PermitJoin { seconds } => format!("Open the Zigbee mesh to pair a device for {seconds}s"),
            Self::RemoveNode { address } => format!("Remove Zigbee node {address} from the mesh"),
            Self::IdentifyAccessPoint { address } => format!("Flash the identify light on Zigbee access point {address}"),
            Self::AddAccessPoint { ip } => format!("Add Zigbee access point at {ip} (the server will dial it on :7910)"),
        }
    }

    /// A node/AP address has to be present; an empty one would be a silent no-op on the mesh.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::RemoveNode { address } | Self::IdentifyAccessPoint { address } if address.trim().is_empty() => {
                Err("a Zigbee address is required".into())
            }
            // A bad IP would have the server dial nowhere; catch it before it leaves.
            Self::AddAccessPoint { ip } if ip.trim().parse::<std::net::IpAddr>().is_err() => {
                Err(format!("“{ip}” is not a valid IP address"))
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_carry_the_server_device_and_params() {
        let open = ZigbeeAction::PermitJoin { seconds: 60 }.calls(15)[0].encode(false);
        assert!(open.contains(r#"name="SetZigbeePermitJoin""#), "{open}");
        assert!(open.contains(r#"<param name="iddevice" type="number">15</param>"#), "{open}");
        assert!(open.contains(r#"<param name="seconds" type="number">60</param>"#), "{open}");

        let rm = ZigbeeAction::RemoveNode { address: "00:0b:57".into() }.calls(15)[0].encode(false);
        assert!(rm.contains("<param name=\"address\" type=\"string\">00:0b:57</param>"), "{rm}");
    }

    #[test]
    fn an_empty_address_is_refused() {
        assert!(ZigbeeAction::RemoveNode { address: "  ".into() }.validate().is_err());
        assert!(ZigbeeAction::IdentifyAccessPoint { address: "".into() }.validate().is_err());
        assert!(ZigbeeAction::PermitJoin { seconds: 0 }.validate().is_ok());
    }

    #[test]
    fn add_access_point_carries_the_ip_and_rejects_a_bad_one() {
        let add = ZigbeeAction::AddAccessPoint { ip: "10.0.0.105".into() };
        assert!(add.validate().is_ok());
        let xml = add.calls(15)[0].encode(false);
        assert!(xml.contains(r#"name="AddZap""#), "{xml}");
        assert!(xml.contains("<param name=\"ip\" type=\"string\">10.0.0.105</param>"), "{xml}");
        assert!(ZigbeeAction::AddAccessPoint { ip: "not-an-ip".into() }.validate().is_err());
    }
}
