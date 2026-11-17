use serde::{Deserialize, Serialize};

/// Permission bit set. Names match the UI contract (`Perm` in contract.ts).
#[derive(Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Perms(pub u32);

pub const NAMES: [&str; 11] = [
    "admin",
    "manage_space",
    "manage_channels",
    "manage_roles",
    "manage_messages",
    "kick",
    "ban",
    "invite",
    "send",
    "speak",
    "stream",
];

impl Perms {
    pub const ADMIN: Perms = Perms(1 << 0);
    pub const MANAGE_SPACE: Perms = Perms(1 << 1);
    pub const MANAGE_CHANNELS: Perms = Perms(1 << 2);
    pub const MANAGE_ROLES: Perms = Perms(1 << 3);
    pub const MANAGE_MESSAGES: Perms = Perms(1 << 4);
    pub const KICK: Perms = Perms(1 << 5);
    pub const BAN: Perms = Perms(1 << 6);
    pub const INVITE: Perms = Perms(1 << 7);
    pub const SEND: Perms = Perms(1 << 8);
    pub const SPEAK: Perms = Perms(1 << 9);
    pub const STREAM: Perms = Perms(1 << 10);
    pub const ALL: Perms = Perms((1 << 11) - 1);
    /// What every member gets through the built-in @everyone role of a fresh space.
    pub const EVERYONE: Perms = Perms(Self::INVITE.0 | Self::SEND.0 | Self::SPEAK.0 | Self::STREAM.0);

    pub fn has(self, p: Perms) -> bool {
        self.0 & Self::ADMIN.0 != 0 || self.0 & p.0 == p.0
    }
    pub fn union(self, o: Perms) -> Perms {
        Perms(self.0 | o.0)
    }
    /// Admin expands to every bit so subset checks behave.
    pub fn effective(self) -> Perms {
        if self.0 & Self::ADMIN.0 != 0 { Self::ALL } else { Perms(self.0 & Self::ALL.0) }
    }
    pub fn subset_of(self, o: Perms) -> bool {
        self.effective().0 & !o.effective().0 == 0
    }
    pub fn names(self) -> Vec<String> {
        NAMES.iter().enumerate().filter(|(i, _)| self.0 & (1 << i) != 0).map(|(_, n)| n.to_string()).collect()
    }
    pub fn from_names<S: AsRef<str>>(names: &[S]) -> anyhow::Result<Perms> {
        let mut p = 0;
        for n in names {
            let i = NAMES.iter().position(|x| *x == n.as_ref()).ok_or_else(|| anyhow::anyhow!("bilinmeyen yetki: {}", n.as_ref()))?;
            p |= 1 << i;
        }
        Ok(Perms(p))
    }
}

impl std::fmt::Debug for Perms {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.names())
    }
}
