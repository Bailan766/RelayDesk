use crate::telemetry::Controller;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const CONFIRM_INTERVAL: Duration = Duration::from_secs(5);
const NODE_COOLDOWN: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, PartialEq)]
pub enum Reachability {
    Checking,
    Healthy,
    Unreachable,
    Unavailable,
}

impl Reachability {
    pub fn name(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::Healthy => "healthy",
            Self::Unreachable => "unreachable",
            Self::Unavailable => "unavailable",
        }
    }
}

pub struct Health {
    pub state: Reachability,
    pub revision: u64,
    pub next_check: Instant,
    failures: u8,
    standby_cursor: usize,
    cooldowns: HashMap<String, Instant>,
}

impl Default for Health {
    fn default() -> Self {
        Self {
            state: Reachability::Checking,
            revision: 0,
            next_check: Instant::now() + CONFIRM_INTERVAL,
            failures: 0,
            standby_cursor: 0,
            cooldowns: HashMap::new(),
        }
    }
}

impl Health {
    pub fn reset(&mut self) {
        *self = Self {
            revision: self.revision.wrapping_add(1),
            ..Self::default()
        };
    }

    pub fn reset_keeping_cooldowns(&mut self) {
        let now = Instant::now();
        let mut cooldowns = std::mem::take(&mut self.cooldowns);
        cooldowns.retain(|_, until| *until > now);
        *self = Self {
            revision: self.revision.wrapping_add(1),
            cooldowns,
            ..Self::default()
        };
    }

    pub fn mark_failed(&mut self, tag: &str) {
        let now = Instant::now();
        self.cooldowns.retain(|_, until| *until > now);
        if !tag.is_empty() {
            self.cooldowns.insert(tag.to_owned(), now + NODE_COOLDOWN);
        }
    }

    pub fn is_cooled_down(&self, tag: &str) -> bool {
        self.cooldowns
            .get(tag)
            .is_some_and(|until| *until > Instant::now())
    }

    pub fn record(&mut self, result: Reachability) {
        self.state = result;
        self.failures = if result == Reachability::Unreachable {
            self.failures.saturating_add(1)
        } else {
            self.standby_cursor = 0;
            0
        };
        let interval = if self.failures == 1 {
            self.state = Reachability::Checking;
            CONFIRM_INTERVAL
        } else {
            CHECK_INTERVAL
        };
        self.next_check = Instant::now() + interval;
    }

    pub fn next_standbys(&mut self, candidates: &[String]) -> Vec<String> {
        if self.failures < 2 || candidates.is_empty() {
            return Vec::new();
        }
        let now = Instant::now();
        self.cooldowns.retain(|_, until| *until > now);
        let fresh: Vec<String> = candidates
            .iter()
            .filter(|tag| !self.cooldowns.contains_key(tag.as_str()))
            .cloned()
            .collect();
        let pool: &[String] = if fresh.is_empty() {
            candidates
        } else {
            &fresh
        };
        const BATCH: usize = 4;
        let start = self.standby_cursor % pool.len();
        let count = BATCH.min(pool.len());
        self.standby_cursor = (start + count) % pool.len();
        pool.iter()
            .cycle()
            .skip(start)
            .take(count)
            .cloned()
            .collect()
    }
}

pub async fn probe(controller: &Controller, tag: &str) -> Reachability {
    const ENDPOINTS: [&str; 2] = [
        "https://www.gstatic.com/generate_204",
        "https://www.apple.com/library/test/success.html",
    ];
    let (first, second) = tokio::join!(
        controller.probe_outbound(tag, ENDPOINTS[0]),
        controller.probe_outbound(tag, ENDPOINTS[1]),
    );
    match (first, second) {
        (Some(true), _) | (_, Some(true)) => Reachability::Healthy,
        (Some(false), Some(false)) => Reachability::Unreachable,
        _ => Reachability::Unavailable,
    }
}

pub async fn uplink_online(controller: &Controller, direct_tag: &str) -> bool {
    const UPLINK_ENDPOINTS: [&str; 2] = [
        "http://www.msftconnecttest.com/connecttest.txt",
        "http://connect.rom.miui.com/generate_204",
    ];
    let (first, second) = tokio::join!(
        controller.probe_outbound(direct_tag, UPLINK_ENDPOINTS[0]),
        controller.probe_outbound(direct_tag, UPLINK_ENDPOINTS[1]),
    );
    !matches!((first, second), (Some(false), Some(false)))
}

pub async fn probe_with_uplink_guard(
    controller: &Controller,
    tag: &str,
    direct_tag: &str,
) -> Reachability {
    let result = probe(controller, tag).await;
    if result == Reachability::Unreachable && !uplink_online(controller, direct_tag).await {
        return Reachability::Unavailable;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_two_confirmed_failures_and_rotates_candidates_in_priority_order() {
        let mut health = Health::default();
        let candidates: Vec<_> = (0..6).map(|index| format!("node-{index}")).collect();
        health.record(Reachability::Unreachable);
        assert!(health.next_standbys(&candidates).is_empty());
        health.record(Reachability::Unavailable);
        health.record(Reachability::Unreachable);
        assert!(health.next_standbys(&candidates).is_empty());
        health.record(Reachability::Unreachable);
        assert_eq!(health.state.name(), "unreachable");
        assert_eq!(health.next_standbys(&candidates), candidates[0..4]);
        assert_eq!(
            health.next_standbys(&candidates),
            ["node-4", "node-5", "node-0", "node-1"]
        );
        health.record(Reachability::Healthy);
        assert!(health.next_standbys(&candidates).is_empty());
    }

    #[test]
    fn cooldown_skips_recently_failed_nodes_and_falls_back_when_all_cooled_down() {
        let mut health = Health::default();
        let candidates: Vec<_> = (0..3).map(|index| format!("node-{index}")).collect();
        health.mark_failed("node-0");
        assert!(health.is_cooled_down("node-0"));
        health.reset_keeping_cooldowns();
        assert!(health.is_cooled_down("node-0"));
        health.record(Reachability::Unreachable);
        health.record(Reachability::Unreachable);
        assert_eq!(health.next_standbys(&candidates), ["node-1", "node-2"]);

        health.mark_failed("node-1");
        health.mark_failed("node-2");
        assert_eq!(
            health.next_standbys(&candidates),
            ["node-0", "node-1", "node-2"]
        );
    }
}
