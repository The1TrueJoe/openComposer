//! Advanced Lighting scenes as a file: export them from one project, import them into the
//! same or another one.
//!
//! A file names its lights by room and name, not id, since ids mean nothing in another
//! project. Import matches each light the same way (room and name, then name alone when
//! that is unique), turns the file into ordinary [`Op`]s for one approval, and lists what
//! it couldn't place. It sends nothing and doesn't carry programming, toggle scenes or
//! anything else Advanced Lighting keeps.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Project;
use crate::agents::{AgentData, AgentKind, AgentState, LightStep, SCENE_LIGHT_DRIVERS};
use crate::ops::Op;

pub const FORMAT: &str = "opencomposer.lighting-scenes";
const VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SceneFile {
    /// Always "opencomposer.lighting-scenes".
    pub format: String,
    pub version: u32,
    /// The project they came from, for people reading the file.
    #[serde(default)]
    pub project: String,
    pub scenes: Vec<SceneEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SceneEntry {
    pub name: String,
    pub lights: Vec<SceneLight>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SceneLight {
    /// The light's name, as the project shows it.
    pub name: String,
    /// Its room, which tells apart lights of the same name.
    #[serde(default)]
    pub room: Option<String>,
    pub steps: Vec<LightStep>,
}

/// The Advanced Lighting agent of a project.
pub fn lighting_agent(p: &Project) -> Option<u32> {
    p.items.values().find(|i| i.driver.as_deref().and_then(AgentKind::from_driver) == Some(AgentKind::AdvancedLighting)).map(|i| i.id)
}

/// The scenes of `agent` named in `only` (all when empty), as a file.
pub fn export(p: &Project, agents: &AgentState, agent: u32, only: &[String]) -> Result<SceneFile, String> {
    let Some(AgentData::Lighting { scenes }) = agents.agent_data.get(&agent) else {
        return Err(format!("#{agent} isn't an Advanced Lighting agent with scenes"));
    };
    let wanted = |n: &str| only.is_empty() || only.iter().any(|o| same(o, n));
    let missing: Vec<&String> = only.iter().filter(|o| !scenes.iter().any(|s| same(&s.name, o))).collect();
    if !missing.is_empty() {
        return Err(format!("no scene named {}", missing.iter().map(|m| format!("“{m}”")).collect::<Vec<_>>().join(", ")));
    }
    let scenes = scenes
        .iter()
        .filter(|s| wanted(&s.name))
        .map(|s| SceneEntry {
            name: s.name.clone(),
            lights: s
                .members
                .iter()
                .map(|m| SceneLight { name: p.name_of(m.device), room: p.room_of(m.device).map(|r| r.name.clone()), steps: m.steps.clone() })
                .collect(),
        })
        .collect();
    Ok(SceneFile { format: FORMAT.into(), version: VERSION, project: p.name.clone(), scenes })
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ImportPlan {
    /// One approval's worth of changes.
    #[serde(skip)]
    pub ops: Vec<Op>,
    /// Scenes the import makes.
    pub added: Vec<String>,
    /// Scenes already here, whose lights the import sets (lights the file doesn't name stay).
    pub updated: Vec<String>,
    /// Lights it couldn't place, worded for a person.
    pub unmatched: Vec<String>,
}

/// The changes that bring `file`'s scenes into `agent`. A scene that exists by name has the
/// file's lights set in it; others are added.
pub fn import(file: &SceneFile, p: &Project, agents: &AgentState, agent: u32) -> Result<ImportPlan, String> {
    if file.format != FORMAT {
        return Err(format!("this isn't an openComposer scenes file (format “{}”)", file.format));
    }
    if file.version > VERSION {
        return Err(format!("this scenes file is version {}; this openComposer reads up to {VERSION}", file.version));
    }
    let existing: Vec<(u32, String)> = match agents.agent_data.get(&agent) {
        Some(AgentData::Lighting { scenes }) => scenes.iter().map(|s| (s.id, s.name.clone())).collect(),
        None => vec![],
        _ => return Err(format!("#{agent} isn't the Advanced Lighting agent")),
    };
    let lights: Vec<u32> = p
        .items
        .values()
        .filter(|i| i.driver.as_deref().is_some_and(|d| SCENE_LIGHT_DRIVERS.iter().any(|w| w.eq_ignore_ascii_case(d))))
        .map(|i| i.id)
        .collect();
    let mut plan = ImportPlan::default();
    // New scenes are predicted the lowest free ids, as the agent ops predict them;
    // approvals point later changes at the ids the agent really gives.
    let mut taken: Vec<u32> = existing.iter().map(|(id, _)| *id).collect();
    for (k, s) in file.scenes.iter().enumerate() {
        if file.scenes[..k].iter().any(|o| same(&o.name, &s.name)) {
            return Err(format!("the file has two scenes named “{}”", s.name));
        }
        let scene = match existing.iter().find(|(_, n)| same(n, &s.name)) {
            Some((id, _)) => {
                plan.updated.push(s.name.clone());
                *id
            }
            None => {
                let id = (0..).find(|i| !taken.contains(i)).unwrap_or(0);
                taken.push(id);
                plan.ops.push(Op::AddLightingScene { agent, name: s.name.clone() });
                plan.added.push(s.name.clone());
                id
            }
        };
        for l in &s.lights {
            match find_light(p, &lights, l) {
                Ok(light) => plan.ops.push(Op::SetSceneLight { agent, scene, light, steps: l.steps.clone(), now: Default::default() }),
                Err(why) => plan.unmatched.push(format!("“{}” in “{}”: {why}", where_(l), s.name)),
            }
        }
    }
    Ok(plan)
}

fn where_(l: &SceneLight) -> String {
    match &l.room {
        Some(r) => format!("{r} / {}", l.name),
        None => l.name.clone(),
    }
}

fn find_light(p: &Project, lights: &[u32], l: &SceneLight) -> Result<u32, &'static str> {
    let named: Vec<u32> = lights.iter().copied().filter(|id| same(&p.name_of(*id), &l.name)).collect();
    let in_room: Vec<u32> = named
        .iter()
        .copied()
        .filter(|id| l.room.as_deref().is_some_and(|r| p.room_of(*id).is_some_and(|x| same(&x.name, r))))
        .collect();
    match (in_room.as_slice(), named.as_slice()) {
        ([one], _) => Ok(*one),
        ([], [one]) => Ok(*one),
        ([], []) => Err("no light of that name here"),
        _ => Err("more than one light of that name here"),
    }
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{LightingMember, LightingScene};
    use crate::model::{Item, ItemKind};

    fn project(lights: &[(u32, &str, u32)]) -> Project {
        let mut p = Project::parse(include_str!("../tests/fixtures/sample-project.xml")).unwrap();
        p.items.insert(7, Item { id: 7, name: "Advanced Lighting".into(), kind: ItemKind::Agent, parent: None, children: vec![], driver: Some("control4_agent_adv_lighting.c4i".into()), properties: Default::default() });
        for (id, name, room) in lights {
            p.items.insert(*id, Item { id: *id, name: (*name).into(), kind: ItemKind::Proxy, parent: Some(*room), children: vec![], driver: Some("light_v2.c4i".into()), properties: Default::default() });
            p.items.get_mut(room).unwrap().children.push(*id);
        }
        p
    }

    fn step(level: u32) -> LightStep {
        LightStep { delay_ms: 0, level: Some(level), rate_ms: 1000, color: None }
    }

    fn with_scenes(scenes: Vec<LightingScene>) -> AgentState {
        let mut a = AgentState::default();
        a.agent_data.insert(7, AgentData::Lighting { scenes });
        a
    }

    fn scene(id: u32, name: &str, members: &[(u32, u32)]) -> LightingScene {
        LightingScene {
            id,
            name: name.into(),
            toggle_id: None,
            active: false,
            members: members.iter().map(|(d, l)| LightingMember { device: *d, steps: vec![step(*l)] }).collect(),
        }
    }

    #[test]
    fn scenes_move_between_projects_by_room_and_name() {
        // Two lights called "Pendant": the room tells them apart.
        let from = project(&[(900, "Pendant", 10), (901, "Pendant", 11), (902, "Lamp", 10)]);
        let ag = with_scenes(vec![scene(0, "Evening", &[(901, 30), (902, 50)]), scene(1, "Off", &[(900, 0)])]);
        assert_eq!(lighting_agent(&from), Some(7));
        let file = export(&from, &ag, 7, &["evening".into()]).unwrap();
        assert_eq!(file.scenes.len(), 1);
        let json = serde_json::to_string(&file).unwrap();
        let file: SceneFile = serde_json::from_str(&json).unwrap();

        // Elsewhere: different ids, one scene of that name already (id 0), no Lamp.
        let to = project(&[(500, "Pendant", 11), (501, "Pendant", 10)]);
        let here = with_scenes(vec![scene(0, "Morning", &[])]);
        let plan = import(&file, &to, &here, 7).unwrap();
        assert_eq!(plan.added, ["Evening"]);
        assert_eq!(plan.unmatched.len(), 1, "{:?}", plan.unmatched);
        assert!(matches!(plan.ops[0], Op::AddLightingScene { .. }));
        assert!(matches!(plan.ops[1], Op::SetSceneLight { scene: 1, light: 500, .. }), "{:?}", plan.ops[1]);

        // Predicting the plan gives the scene its lights.
        let (mut p, mut a) = (to.clone(), here.clone());
        for op in &plan.ops {
            op.predict(&mut p, &mut a).unwrap();
        }
        let Some(AgentData::Lighting { scenes }) = a.agent_data.get(&7) else { panic!() };
        assert_eq!(scenes.iter().find(|s| s.name == "Evening").unwrap().members.len(), 1);

        // Again: it's there now, so the lights are set in it rather than a second one added.
        let again = import(&file, &p, &a, 7).unwrap();
        assert_eq!((again.added.len(), again.updated.as_slice()), (0, ["Evening".to_string()].as_slice()));
    }

    #[test]
    fn bad_files_are_refused() {
        let p = project(&[]);
        let a = with_scenes(vec![]);
        let mut f = SceneFile { format: "x".into(), version: 1, project: String::new(), scenes: vec![] };
        assert!(import(&f, &p, &a, 7).is_err());
        f.format = FORMAT.into();
        f.version = 99;
        assert!(import(&f, &p, &a, 7).is_err());
        assert!(export(&p, &a, 7, &["Nope".into()]).is_err());
    }
}
