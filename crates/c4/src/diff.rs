//! Semantic project diff: what changed, in Composer's terms rather than XML lines.
//!
//! Used three ways: the preview on an approval card (live snapshot vs. the snapshot
//! with the proposed ops applied), verification after a write (before vs. after), and
//! comparing backups or systems.
//!
//! Each change carries enough context (names, room path, connection names) to render
//! on its own, because the UI shows changes from two projects that may not both exist
//! any more by the time someone looks at the card.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::model::{Binding, CodeItem, ItemKind, Names, NetworkBinding, Project, Variable};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct DiffOptions {
    /// Include things that change on their own while a system runs: variable values,
    /// network status, discovered IP addresses. Off when comparing configurations.
    pub runtime: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Diff {
    pub changes: Vec<Change>,
    pub summary: Summary,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Summary {
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
}

/// Where something lives, top-down, e.g. `["House", "Main", "Living"]`.
pub type Location = Vec<String>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ItemRef {
    pub id: u32,
    pub name: String,
    pub item_kind: ItemKind,
    pub location: Location,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Endpoint {
    pub device: ItemRef,
    pub binding: u32,
    pub connection: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Connection {
    pub consumer: Endpoint,
    pub provider: Endpoint,
    pub classes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LineOp {
    Same,
    Added,
    Removed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CodeLine {
    pub op: LineOp,
    pub depth: usize,
    pub text: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    ItemAdded { item: ItemRef, driver: Option<String>, descendants: usize },
    ItemRemoved { item: ItemRef, driver: Option<String>, descendants: usize },
    ItemRenamed { item: ItemRef, from: String, to: String },
    ItemMoved { item: ItemRef, from: Location, to: Location },
    DriverChanged { item: ItemRef, from: Option<String>, to: Option<String> },
    PropertyChanged { item: ItemRef, property: String, from: Option<String>, to: Option<String> },
    ConnectionAdded { connection: Connection },
    /// `cascade` = removed because one end's item was removed.
    ConnectionRemoved { connection: Connection, cascade: bool },
    NetworkAdded { item: ItemRef, binding: u32, address_type: u32, address: String, uuid: String, search_type: String },
    NetworkRemoved { item: ItemRef, binding: u32, address_type: u32, address: String, uuid: String, search_type: String, cascade: bool },
    NetworkChanged { item: ItemRef, binding: u32, field: String, from: String, to: String },
    VariableAdded { owner: ItemRef, id: u32, name: String, value: String },
    VariableRemoved { owner: ItemRef, id: u32, name: String, value: String, cascade: bool },
    VariableChanged { owner: ItemRef, id: u32, name: String, field: String, from: String, to: String },
    ProgrammingChanged { owner: ItemRef, event: u32, event_name: Option<String>, lines: Vec<CodeLine> },
}

impl Change {
    fn tally(&self, s: &mut Summary) {
        match self {
            Change::ItemAdded { .. } | Change::ConnectionAdded { .. } | Change::NetworkAdded { .. } | Change::VariableAdded { .. } => s.added += 1,
            Change::ItemRemoved { .. } | Change::ConnectionRemoved { .. } | Change::NetworkRemoved { .. } | Change::VariableRemoved { .. } => s.removed += 1,
            _ => s.changed += 1,
        }
    }

    /// A stable identity used to compare a predicted diff with what actually happened.
    pub fn key(&self) -> String {
        match self {
            Change::ItemAdded { item, .. } => format!("item+:{}:{}", item.name, item.location.join("/")),
            Change::ItemRemoved { item, .. } => format!("item-:{}", item.id),
            Change::ItemRenamed { item, to, .. } => format!("rename:{}:{to}", item.id),
            Change::ItemMoved { item, to, .. } => format!("move:{}:{}", item.id, to.join("/")),
            Change::DriverChanged { item, .. } => format!("driver:{}", item.id),
            Change::PropertyChanged { item, property, .. } => format!("prop:{}:{property}", item.id),
            Change::ConnectionAdded { connection: c } | Change::ConnectionRemoved { connection: c, .. } => format!(
                "conn{}:{}:{}:{}:{}",
                if matches!(self, Change::ConnectionAdded { .. }) { "+" } else { "-" },
                c.consumer.device.name, c.consumer.binding, c.provider.device.name, c.provider.binding
            ),
            Change::NetworkAdded { item, binding, .. } => format!("net+:{}:{binding}", item.name),
            Change::NetworkRemoved { item, binding, .. } => format!("net-:{}:{binding}", item.id),
            Change::NetworkChanged { item, binding, field, .. } => format!("net~:{}:{binding}:{field}", item.id),
            Change::VariableAdded { owner, name, .. } => format!("var+:{}:{name}", owner.name),
            Change::VariableRemoved { owner, id, .. } => format!("var-:{}:{id}", owner.id),
            Change::VariableChanged { owner, id, field, .. } => format!("var~:{}:{id}:{field}", owner.id),
            Change::ProgrammingChanged { owner, event, .. } => format!("code:{}:{event}", owner.id),
        }
    }
}

struct Ctx<'a> {
    before: &'a Project,
    after: &'a Project,
    names: &'a Names,
}

impl Ctx<'_> {
    /// Describe an item from whichever side knows it (after first, so renames show the new name).
    fn item(&self, id: u32) -> ItemRef {
        let (p, it) = match (self.after.item(id), self.before.item(id)) {
            (Some(i), _) => (self.after, i),
            (None, Some(i)) => (self.before, i),
            (None, None) => {
                return ItemRef { id, name: format!("#{id}"), item_kind: ItemKind::Other(0), location: vec![] };
            }
        };
        ItemRef { id, name: it.name.clone(), item_kind: it.kind, location: location(p, id) }
    }

    fn item_in(&self, p: &Project, id: u32) -> ItemRef {
        match p.item(id) {
            Some(it) => ItemRef { id, name: it.name.clone(), item_kind: it.kind, location: location(p, id) },
            None => self.item(id),
        }
    }

    fn connection(&self, p: &Project, b: &Binding) -> Connection {
        Connection {
            consumer: Endpoint {
                device: self.item_in(p, b.consumer_device),
                binding: b.consumer_binding,
                connection: Some(b.consumer_name.clone()).filter(|n| !n.is_empty()),
            },
            provider: Endpoint {
                device: self.item_in(p, b.provider_device),
                binding: b.provider_binding,
                connection: self.names.connection(b.provider_device, b.provider_binding).map(String::from),
            },
            classes: b.classes.clone(),
        }
    }
}

fn location(p: &Project, id: u32) -> Location {
    p.ancestors(id).iter().map(|i| i.name.clone()).collect()
}

pub fn diff(before: &Project, after: &Project, names: &Names, opts: DiffOptions) -> Diff {
    let cx = Ctx { before, after, names };
    let mut changes = Vec::new();

    // Items. Report the top of a removed/added subtree once, with a descendant count.
    let removed: BTreeSet<u32> = before.items.keys().filter(|id| !after.items.contains_key(id)).copied().collect();
    let added: BTreeSet<u32> = after.items.keys().filter(|id| !before.items.contains_key(id)).copied().collect();
    for &id in &removed {
        let it = &before.items[&id];
        if it.parent.is_some_and(|p| removed.contains(&p)) {
            continue;
        }
        changes.push(Change::ItemRemoved {
            item: cx.item_in(before, id),
            driver: it.driver.clone(),
            descendants: before.subtree(id).len() - 1,
        });
    }
    for &id in &added {
        let it = &after.items[&id];
        if it.parent.is_some_and(|p| added.contains(&p)) {
            continue;
        }
        changes.push(Change::ItemAdded {
            item: cx.item_in(after, id),
            driver: it.driver.clone(),
            descendants: after.subtree(id).len() - 1,
        });
    }
    for (id, b) in &before.items {
        let Some(a) = after.items.get(id) else { continue };
        if a.name != b.name {
            changes.push(Change::ItemRenamed { item: cx.item(*id), from: b.name.clone(), to: a.name.clone() });
        }
        if a.parent != b.parent {
            changes.push(Change::ItemMoved { item: cx.item(*id), from: location(before, *id), to: location(after, *id) });
        }
        if a.driver != b.driver {
            changes.push(Change::DriverChanged { item: cx.item(*id), from: b.driver.clone(), to: a.driver.clone() });
        }
        let keys: BTreeSet<&String> = a.properties.keys().chain(b.properties.keys()).collect();
        for k in keys {
            let (from, to) = (b.properties.get(k), a.properties.get(k));
            if from != to {
                changes.push(Change::PropertyChanged {
                    item: cx.item(*id),
                    property: k.clone(),
                    from: from.cloned(),
                    to: to.cloned(),
                });
            }
        }
    }

    // Connections.
    let bk: BTreeMap<_, &Binding> = before.bindings.iter().map(|b| (b.key(), b)).collect();
    let ak: BTreeMap<_, &Binding> = after.bindings.iter().map(|b| (b.key(), b)).collect();
    for (k, b) in &bk {
        if !ak.contains_key(k) {
            let cascade = removed.contains(&b.consumer_device) || removed.contains(&b.provider_device);
            changes.push(Change::ConnectionRemoved { connection: cx.connection(before, b), cascade });
        }
    }
    for (k, b) in &ak {
        if !bk.contains_key(k) {
            changes.push(Change::ConnectionAdded { connection: cx.connection(after, b) });
        }
    }

    // Network bindings.
    let nk = |n: &NetworkBinding| (n.device, n.binding);
    let bn: BTreeMap<_, &NetworkBinding> = before.network_bindings.iter().map(|n| (nk(n), n)).collect();
    let an: BTreeMap<_, &NetworkBinding> = after.network_bindings.iter().map(|n| (nk(n), n)).collect();
    for (k, n) in &bn {
        match an.get(k) {
            None => changes.push(Change::NetworkRemoved {
                item: cx.item_in(before, n.device),
                binding: n.binding,
                address_type: n.address_type,
                address: n.address.clone(),
                uuid: n.uuid.clone(),
                search_type: n.search_type.clone(),
                cascade: removed.contains(&n.device),
            }),
            Some(a) => {
                let mut fields = vec![
                    ("address type", n.address_type.to_string(), a.address_type.to_string()),
                    ("uuid", n.uuid.clone(), a.uuid.clone()),
                    ("search type", n.search_type.clone(), a.search_type.clone()),
                ];
                if opts.runtime || n.uuid.is_empty() {
                    fields.push(("address", n.address.clone(), a.address.clone()));
                }
                if opts.runtime {
                    fields.push(("status", n.status.clone(), a.status.clone()));
                }
                for (field, from, to) in fields {
                    if from != to {
                        changes.push(Change::NetworkChanged { item: cx.item(n.device), binding: n.binding, field: field.into(), from, to });
                    }
                }
            }
        }
    }
    for (k, n) in &an {
        if !bn.contains_key(k) {
            changes.push(Change::NetworkAdded {
                item: cx.item_in(after, n.device),
                binding: n.binding,
                address_type: n.address_type,
                address: n.address.clone(),
                uuid: n.uuid.clone(),
                search_type: n.search_type.clone(),
            });
        }
    }

    // Variables.
    let vk = |v: &Variable| (v.device, v.id);
    let bv: BTreeMap<_, &Variable> = before.variables.iter().map(|v| (vk(v), v)).collect();
    let av: BTreeMap<_, &Variable> = after.variables.iter().map(|v| (vk(v), v)).collect();
    for (k, v) in &bv {
        match av.get(k) {
            None => changes.push(Change::VariableRemoved {
                owner: cx.item_in(before, v.device),
                id: v.id,
                name: v.name.clone(),
                value: v.value.clone(),
                cascade: removed.contains(&v.device),
            }),
            Some(a) => {
                let mut fields = vec![("name", v.name.clone(), a.name.clone())];
                if opts.runtime {
                    fields.push(("value", v.value.clone(), a.value.clone()));
                }
                for (field, from, to) in fields {
                    if from != to {
                        changes.push(Change::VariableChanged { owner: cx.item(v.device), id: v.id, name: a.name.clone(), field: field.into(), from, to });
                    }
                }
            }
        }
    }
    for (k, v) in &av {
        if !bv.contains_key(k) {
            changes.push(Change::VariableAdded { owner: cx.item_in(after, v.device), id: v.id, name: v.name.clone(), value: v.value.clone() });
        }
    }

    // Programming, one change per event whose code differs.
    let events: BTreeSet<&String> = before.programming.keys().chain(after.programming.keys()).collect();
    let empty = Vec::new();
    for key in events {
        let b = before.programming.get(key).unwrap_or(&empty);
        let a = after.programming.get(key).unwrap_or(&empty);
        if a == b {
            continue;
        }
        let (dev, ev) = key.split_once(':').map(|(d, e)| (d.parse().unwrap_or(0), e.parse().unwrap_or(0))).unwrap_or((0, 0));
        changes.push(Change::ProgrammingChanged {
            owner: cx.item(dev),
            event: ev,
            event_name: names.event(dev, ev).map(String::from),
            lines: diff_code(&flatten(b), &flatten(a)),
        });
    }

    let mut summary = Summary::default();
    for c in &changes {
        c.tally(&mut summary);
    }
    Diff { changes, summary }
}

fn flatten(code: &[CodeItem]) -> Vec<(usize, String, bool)> {
    fn walk(items: &[CodeItem], depth: usize, out: &mut Vec<(usize, String, bool)>) {
        for c in items {
            out.push((depth, c.display.clone(), c.enabled));
            walk(&c.children, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(code, 0, &mut out);
    out
}

/// Line diff by longest common subsequence; programs per event are short.
fn diff_code(a: &[(usize, String, bool)], b: &[(usize, String, bool)]) -> Vec<CodeLine> {
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let line = |op, l: &(usize, String, bool)| CodeLine { op, depth: l.0, text: l.1.clone(), enabled: l.2 };
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.push(line(LineOp::Same, &a[i]));
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            out.push(line(LineOp::Added, &b[j]));
            j += 1;
        } else {
            out.push(line(LineOp::Removed, &a[i]));
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::event_key;

    fn sample() -> Project {
        Project::parse(include_str!("../tests/fixtures/sample-project.xml")).unwrap()
    }

    #[test]
    fn identical_projects_have_no_changes() {
        let p = sample();
        assert!(diff(&p, &p, &Names::default(), DiffOptions::default()).changes.is_empty());
    }

    #[test]
    fn removing_a_device_cascades_once() {
        let before = sample();
        let mut after = before.clone();
        for id in after.subtree(20) {
            after.items.remove(&id);
        }
        after.items.get_mut(&10).unwrap().children.retain(|c| *c != 20);
        after.bindings.retain(|b| b.consumer_device != 20);
        after.network_bindings.retain(|n| n.device != 20);
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let removed: Vec<_> = d.changes.iter().filter(|c| matches!(c, Change::ItemRemoved { .. })).collect();
        assert_eq!(removed.len(), 1, "proxy under the TV is folded into its parent");
        assert!(matches!(removed[0], Change::ItemRemoved { descendants: 1, .. }));
        assert!(d.changes.iter().any(|c| matches!(c, Change::ConnectionRemoved { cascade: true, .. })));
        assert!(d.changes.iter().any(|c| matches!(c, Change::NetworkRemoved { cascade: true, .. })));
    }

    #[test]
    fn programming_diff_shows_inserted_line() {
        let before = sample();
        let mut after = before.clone();
        let code = after.programming.get_mut(&event_key(20, 1)).unwrap();
        let mut extra = code[0].children[0].clone();
        extra.display = "Dim Kitchen to 40%".into();
        code[0].children.push(extra);
        let d = diff(&before, &after, &Names::default(), DiffOptions::default());
        let Change::ProgrammingChanged { lines, .. } = &d.changes[0] else { panic!("{:?}", d.changes) };
        let added: Vec<_> = lines.iter().filter(|l| l.op == LineOp::Added).map(|l| l.text.as_str()).collect();
        assert_eq!(added, ["Dim Kitchen to 40%"]);
        assert_eq!(lines.iter().filter(|l| l.op == LineOp::Same).count(), 2);
    }
}
