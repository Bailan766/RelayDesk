use crate::telemetry::Controller;
use std::time::{Duration, Instant};

const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const CONFIRM_INTERVAL: Duration = Duration::from_secs(5);

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
}

impl Default for Health {
    fn default() -> Self {
        Self {
            state: Reachability::Checking,
            revision: 0,
            next_check: Instant::now() + CONFIRM_INTERVAL,
            failures: 0,
            standby_cursor: 0,
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
        const BATCH: usize = 4;
        let start = self.standby_cursor % candidates.len();
        let count = BATCH.min(candidates.len());
        self.standby_cursor = (start + count) % candidates.len();
        candidates
            .iter()
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
}
