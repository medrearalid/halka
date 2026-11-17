//! Views sent to the UI. Mirrors app/src/ipc/contract.ts.

use serde::{Deserialize, Serialize};

use crate::id::Id;
use crate::op::ChannelKind;

#[derive(Clone, Debug, Serialize)]
pub struct Me {
    pub id: Id,
    pub name: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChannelView {
    pub id: Id,
    pub name: String,
    pub kind: ChannelKind,
    pub private_roles: Option<Vec<Id>>,
    pub voice: Vec<Id>,
    pub streams: Vec<Id>,
    pub unread: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct RoleView {
    pub id: Id,
    pub name: String,
    pub color: u32,
    pub perms: Vec<String>,
    pub rank: u32,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnKind {
    #[serde(rename = "self")]
    Me,
    Direct,
    Relay,
    None,
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceState {
    pub channel: Id,
    pub muted: bool,
    pub deafened: bool,
    pub streaming: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemberView {
    pub id: Id,
    pub name: String,
    pub roles: Vec<Id>,
    pub is_owner: bool,
    pub online: bool,
    pub conn: ConnKind,
    pub rtt_ms: Option<u32>,
    pub voice: Option<VoiceState>,
}

#[derive(Clone, Debug, Serialize)]
pub struct InviteView {
    pub id: Id,
    pub created_by: Id,
    pub expires: Option<u64>,
    pub max_uses: Option<u32>,
    pub uses: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct SpaceView {
    pub id: Id,
    pub name: String,
    pub owner: Id,
    pub my_perms: Vec<String>,
    pub channels: Vec<ChannelView>,
    pub roles: Vec<RoleView>,
    pub members: Vec<MemberView>,
    pub bans: Vec<Id>,
    pub invites: Vec<InviteView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageView {
    pub id: Id,
    pub space: Id,
    pub channel: Id,
    pub author: Id,
    pub ts: u64,
    pub text: String,
    pub reply_to: Option<Id>,
    pub edited: bool,
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub relay_only: bool,
    pub relays: Vec<String>,
    pub noise_suppression: bool,
    pub echo_cancellation: bool,
    pub push_to_talk: bool,
    pub ptt_key: String,
    pub vad_threshold: f32,
    /// Hear people from the side of the ring they sit on (stereo panning).
    pub spatial_audio: bool,
    pub input: Option<String>,
    pub output: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            relay_only: false,
            relays: vec![],
            noise_suppression: true,
            echo_cancellation: true,
            push_to_talk: false,
            ptt_key: "KeyV".into(),
            vad_threshold: 0.3,
            spatial_audio: false,
            input: None,
            output: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MyVoice {
    pub space: Id,
    pub channel: Id,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub me: Me,
    pub spaces: Vec<SpaceView>,
    pub settings: Settings,
    pub voice: Option<MyVoice>,
    pub online: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AudioDevices {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub input: Option<String>,
    pub output: Option<String>,
}

/// Everything the core pushes to the shell.
#[derive(Debug)]
pub enum Event {
    /// State changed; the shell should send a fresh snapshot (it debounces).
    Changed,
    Message(MessageView),
    Levels(Vec<(Id, f32)>),
    Notice {
        error: bool,
        text: String,
    },
    StreamEnded(Id),
    /// We're sharing and a watcher needs a key frame.
    StreamKeyframe,
    /// We're sharing and a watcher's link can't keep up: lower the encoder bitrate.
    StreamCongested,
}

/// Human-comparable safety code from a public key: 12 Crockford base32 chars, 3 groups.
pub fn safety_code(id: &Id) -> String {
    let h = Id::hash("halka/safety/v1", &id.0);
    let s = data_encoding::BASE32_NOPAD.encode(&h.0[..8]);
    let s: String = s.chars().take(12).collect();
    format!("{}-{}-{}", &s[0..4], &s[4..8], &s[8..12])
}
