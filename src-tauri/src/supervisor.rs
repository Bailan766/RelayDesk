use crate::{network, telemetry::Controller};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(12),
];
const HEALTHY_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Plan {
    pub config: Value,
    pub port: u16,
    pub mode: String,
    pub routing_mode: network::RoutingMode,
    pub recover: bool,
}

impl Plan {
    fn start(&self) -> Result<network::Session, String> {
        network::Session::start(
            self.config.clone(),
            self.port,
            &self.mode,
            self.routing_mode,
        )
    }
}

struct Running {
    session: network::Session,
    plan: Plan,
    since: Instant,
    failures: usize,
    retry_at: Option<Instant>,
}

impl Running {
    fn retry_delay(&self) -> Option<Duration> {
        recovery_delay(self.plan.recover, &self.plan.mode, self.failures)
    }
}

fn recovery_delay(enabled: bool, mode: &str, failures: usize) -> Option<Duration> {
    if enabled && matches!(mode, "local" | "system") {
        RETRY_DELAYS.get(failures).copied()
    } else {
        None
    }
}

#[derive(Default)]
struct Slot {
    active: Option<Running>,
    message: Option<&'static str>,
}

#[derive(Default)]
pub struct Supervisor {
    slot: Mutex<Slot>,
    closing: AtomicBool,
}

#[derive(serde::Serialize)]
pub struct Status {
    phase: &'static str,
    message: Option<&'static str>,
}

pub struct Link {
    pub id: String,
    pub port: u16,
    pub controller: Controller,
}

impl Supervisor {
    pub fn start(&self, plan: Plan) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        if self.closing.load(Ordering::Acquire) {
            return Err("应用正在退出".into());
        }
        if slot
            .active
            .as_ref()
            .is_some_and(|active| active.session.running())
        {
            return Err("代理已经运行".into());
        }
        let session = plan.start()?;
        slot.active = Some(Running {
            session,
            plan,
            since: Instant::now(),
            failures: 0,
            retry_at: None,
        });
        slot.message = None;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        slot.message = None;
        match slot.active.take() {
            Some(active) if active.session.running() => active.session.stop(),
            Some(_) => network::recover(),
            None => Ok(()),
        }
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::Release);
        self.stop()
    }

    pub fn status(&self) -> Status {
        let Ok(slot) = self.slot.try_lock() else {
            return Status {
                phase: "busy",
                message: None,
            };
        };
        let phase = match &slot.active {
            Some(active) if active.session.running() => "running",
            Some(_) => "recovering",
            None => "stopped",
        };
        let message = if phase == "recovering" {
            Some("内核已退出，正在检查能否恢复")
        } else {
            slot.message
        };
        Status { phase, message }
    }

    pub fn live(&self) -> Result<Option<Link>, String> {
        let slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        Ok(slot
            .active
            .as_ref()
            .filter(|active| active.session.running())
            .map(|active| Link {
                id: active.session.id.clone(),
                port: active.session.port,
                controller: active.session.controller.clone(),
            }))
    }

    pub fn update_plan(&self, id: &str, update: impl FnOnce(&mut Plan)) -> bool {
        if let Ok(mut slot) = self.slot.lock() {
            if let Some(active) = slot
                .active
                .as_mut()
                .filter(|active| active.session.id == id)
            {
                update(&mut active.plan);
                return true;
            }
        }
        false
    }

    pub fn configure_recovery(&self, enabled: bool) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        if let Some(active) = slot.active.as_mut() {
            active.plan.recover = enabled;
        }
        Ok(())
    }

    fn tick(&self) {
        let Ok(mut slot) = self.slot.try_lock() else {
            return;
        };
        let Some(active) = slot.active.as_mut() else {
            return;
        };
        if active.session.running() {
            if active.since.elapsed() >= HEALTHY_INTERVAL {
                active.failures = 0;
            }
            return;
        }
        let Some(delay) = active.retry_delay() else {
            let tun = active.plan.mode == "tun";
            let exhausted = active.failures >= RETRY_DELAYS.len();
            slot.active.take();
            slot.message = Some(if network::recover().is_err() {
                "内核已退出，系统代理恢复暂未确认，请重新检查 Windows 代理设置"
            } else if tun {
                "TUN 内核已退出，重新连接时需要管理员授权"
            } else if exhausted {
                "自动恢复失败，已退出接管"
            } else {
                "内核意外退出，已恢复网络设置"
            });
            return;
        };
        let retry_at = active
            .retry_at
            .get_or_insert_with(|| Instant::now() + delay);
        if Instant::now() < *retry_at || self.closing.load(Ordering::Acquire) {
            return;
        }
        active.failures += 1;
        active.retry_at = None;
        if let Ok(session) = active.plan.start() {
            active.session = session;
            active.since = Instant::now();
            slot.message = Some("代理已自动恢复");
        }
    }

    pub fn run(app: tauri::AppHandle) {
        use tauri::Manager;
        let state = app.state::<Self>();
        while !state.closing.load(Ordering::Acquire) {
            state.tick();
            thread::sleep(Duration::from_millis(400));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_recovery_is_bounded_and_never_requests_tun_elevation() {
        assert_eq!(
            recovery_delay(true, "system", 0),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            recovery_delay(true, "local", 2),
            Some(Duration::from_secs(12))
        );
        assert!(recovery_delay(true, "system", 3).is_none());
        assert!(recovery_delay(false, "local", 0).is_none());
        assert!(recovery_delay(true, "tun", 0).is_none());
    }
}
