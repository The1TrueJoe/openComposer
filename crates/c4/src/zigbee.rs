//! Zigbee network management (Composer Pro's Network → Zigbee tools).
//!
//! The read side lives in [`crate::director::ZigbeeQuery`]: `GetZigbeeZserverInfo`,
//! `GetZigbeeMeshInfo`, `GetAllZigbeeNodes` and `GetZigbeeZaps`, each answered by an
//! event. This module is the *config* side — the actions that change the live mesh:
//! opening the join window to pair a device, dropping a node, flashing an access point,
//! and enabling/disabling a device as an access point ("zap"). They carry no project data,
//! so, like [`crate::ops::Op::SendCommand`], they change nothing in the snapshot and are
//! approved only because they act on real hardware.
//!
//! `iddevice` is the device the action targets. For permit-join / remove-node / identify
//! that is the controller's own Zigbee server (the Director's device id — 15 on the EA-3
//! test rig, 30 on a typical EA-1). For enable/disable-zap it is the AP's OWN device id —
//! never the Director's, or you would make the controller itself a zap.
//!
//! What this module is NOT: the AP data plane. The zserver drives access points over a
//! separate protobuf protocol on TCP 7910 (a sibling project reimplements that); here we
//! only speak the Director's c4soap management plane, as Composer does.
//!
//! ponytail: the four `Get*` reads are confirmed. Among the writes, `ENABLE_ZAP` /
//! `DISABLE_ZAP` are the real path for adding an access point — pinned from the node
//! broker's `sendAsyncDeviceCommand(iddevice, 'ENABLE_ZAP', …)` after the first guess
//! (a top-level `AddZaps` c4soap verb) was rejected live as "Unknown or invalid method":
//! that verb is a zserver-internal, localhost-only command, not reachable over c4soap.
//! Their *param* names/types (`coordinator`, `idowner`, both INT) are still inferred from
//! the broker JS. The three mesh-node verbs (`SetZigbeePermitJoin`, `RemoveZigbeeNode`,
//! `IdentifyZigbeeZap`) remain best-inference and unverified. Every write is gated behind
//! the approval path, so a wrong name errors harmlessly. Precondition for enable-zap: the
//! target device must already be radio-capable (its announce) with a Target IP set, or the
//! Director refuses it — that identity/driver gap is separate work.

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
    /// Enable a device as a Zigbee access point ("zap"). This is the real c4soap path for
    /// adding an AP: an `ENABLE_ZAP` device command sent to the AP's OWN device id (the
    /// `iddevice` of this op), which makes the Director dial that device at its *project*
    /// Target IP — there is no c4soap call that takes a raw IP. `coordinator` makes it form
    /// and own the mesh; `idowner` is the owning device id and defaults to the target.
    EnableZap { coordinator: bool, idowner: Option<u32> },
    /// Disable a device as a Zigbee access point (the backout for [`Self::EnableZap`]),
    /// sent to that device's id.
    DisableZap,
}

impl ZigbeeAction {
    /// The c4soap call(s) Composer would send for this action. See the module `ponytail`
    /// note: the method/param names are unverified against a live mesh.
    pub fn calls(&self, iddevice: u32) -> Vec<Call> {
        match self {
            // ponytail: unverified mesh-node verbs (see module note).
            Self::PermitJoin { seconds } => {
                vec![Call::new("SetZigbeePermitJoin").num("iddevice", iddevice).num("seconds", *seconds)]
            }
            Self::RemoveNode { address } => {
                vec![Call::new("RemoveZigbeeNode").num("iddevice", iddevice).str("address", address)]
            }
            Self::IdentifyAccessPoint { address } => {
                vec![Call::new("IdentifyZigbeeZap").num("iddevice", iddevice).str("address", address)]
            }
            // Pinned verb `ENABLE_ZAP`, sent as a device command to the AP's own id (the
            // broker's sendAsyncDeviceCommand). ponytail: the param names/types below are
            // inferred from the broker JS; confirm against a live accept.
            Self::EnableZap { coordinator, idowner } => {
                let owner = idowner.unwrap_or(iddevice);
                let cmd = crate::agents::device_command(
                    "ENABLE_ZAP",
                    &[("coordinator", "INT", if *coordinator { "1" } else { "0" }), ("idowner", "INT", &owner.to_string())],
                );
                vec![Call::new("SendToDevice").num("iddevice", iddevice).xml("data", cmd)]
            }
            Self::DisableZap => {
                let cmd = crate::agents::device_command("DISABLE_ZAP", &[]);
                vec![Call::new("SendToDevice").num("iddevice", iddevice).xml("data", cmd)]
            }
        }
    }

    /// One line for an approval card. `iddevice` is the device the action targets.
    pub fn describe(&self, iddevice: u32) -> String {
        match self {
            Self::PermitJoin { seconds: 0 } => "Close the Zigbee join window".into(),
            Self::PermitJoin { seconds } => format!("Open the Zigbee mesh to pair a device for {seconds}s"),
            Self::RemoveNode { address } => format!("Remove Zigbee node {address} from the mesh"),
            Self::IdentifyAccessPoint { address } => format!("Flash the identify light on Zigbee access point {address}"),
            Self::EnableZap { coordinator, .. } => {
                let role = if *coordinator { ", as the mesh coordinator" } else { "" };
                format!("Enable device {iddevice} as a Zigbee access point{role}")
            }
            Self::DisableZap => format!("Disable the Zigbee access point on device {iddevice}"),
        }
    }

    /// A node/AP address has to be present; an empty one would be a silent no-op on the mesh.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::RemoveNode { address } | Self::IdentifyAccessPoint { address } if address.trim().is_empty() => {
                Err("a Zigbee address is required".into())
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
    fn enable_zap_sends_the_device_command_to_the_ap_device() {
        // Target is the AP's own device id (45 here), NOT the Director.
        let xml = ZigbeeAction::EnableZap { coordinator: true, idowner: None }.calls(45)[0].encode(false);
        assert!(xml.contains(r#"name="SendToDevice""#), "{xml}");
        assert!(xml.contains(r#"<param name="iddevice" type="number">45</param>"#), "{xml}");
        assert!(xml.contains("<command>ENABLE_ZAP</command>"), "{xml}");
        assert!(xml.contains("<name>coordinator</name>"), "{xml}");
        // idowner defaults to the target device id.
        assert!(xml.contains("<name>idowner</name>"), "{xml}");
        assert!(xml.contains("<static>45</static>"), "{xml}");

        let off = ZigbeeAction::DisableZap.calls(45)[0].encode(false);
        assert!(off.contains("<command>DISABLE_ZAP</command>"), "{off}");
    }
}
