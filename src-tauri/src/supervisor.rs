use crate::{
    failover::{self, Health, Reachability},
    network,
    telemetry::Controller,
};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(12),
];
const HEALTHY_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Plan {
    pub core: network::Core,
    pub config: Value,
    pub port: u16,
    pub mode: String,
    pub routing_mode: network::RoutingMode,
    pub recover: bool,
    pub failover: bool,
    pub fallback_groups: Vec<Vec<String>>,
}

impl Plan {
    fn start(&self) -> Result<network::Session, String> {
        network::Session::start(
            self.config.clone(),
            self.port,
            &self.mode,
            self.routing_mode,
            self.core,
        )
    }

    fn selector(&self) -> Option<&Value> {
        let selector = self.config.get("outbounds")?.as_array()?.first()?;
        (selector.get("type")?.as_str()? == "selector").then_some(selector)
    }

    fn selected_node(&self) -> Option<&str> {
        self.selector()?
            .get("default")?
            .as_str()
            .filter(|tag| valid_tag(tag))
    }

    fn standbys(&self, selected: &str) -> Vec<String> {
        let Some(loaded) = self
            .selector()
            .and_then(|selector| selector["outbounds"].as_array())
        else {
            return Vec::new();
        };
        let mut loaded: HashSet<_> = loaded.iter().filter_map(Value::as_str).collect();
        self.fallback_groups
            .iter()
            .find(|group| group.iter().any(|tag| tag == selected))
            .into_iter()
            .flatten()
            .filter(|tag| tag.as_str() != selected && valid_tag(tag) && loaded.remove(tag.as_str()))
            .cloned()
            .collect()
    }

    fn monitors_node(&self) -> bool {
        self.core == network::Core::Singbox
            && self.failover
            && !matches!(self.routing_mode, network::RoutingMode::Direct)
    }
}

fn valid_tag(tag: &str) -> bool {
    tag.strip_prefix("node-").is_some_and(|index| {
        index.parse::<usize>().is_ok_and(|value| value < 2048)
            && index.bytes().all(|byte| byte.is_ascii_digit())
    })
}

struct Running {
    session: network::Session,
    plan: Plan,
    since: Instant,
    failures: usize,
    retry_at: Option<Instant>,
    health: Health,
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
    events: VecDeque<Event>,
    next_event: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct Event {
    sequence: u64,
    timestamp: u64,
    level: &'static str,
    message: &'static str,
}

impl Slot {
    fn record(&mut self, level: &'static str, message: &'static str) {
        const LIMIT: usize = 160;
        if self.events.len() == LIMIT {
            self.events.pop_front();
        }
        self.next_event += 1;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.events.push_back(Event {
            sequence: self.next_event,
            timestamp,
            level,
            message,
        });
    }
}

#[derive(Default)]
pub struct Supervisor {
    slot: Mutex<Slot>,
    closing: AtomicBool,
    control: tokio::sync::Mutex<()>,
}

#[derive(serde::Serialize)]
pub struct Status {
    phase: &'static str,
    message: Option<&'static str>,
    session_id: Option<String>,
    node_tag: Option<String>,
    node_health: Option<&'static str>,
}

struct NodeCheck {
    session: String,
    revision: u64,
    tag: String,
    controller: Controller,
}

impl NodeCheck {
    fn is_current(&self, active: &Running) -> bool {
        active.session.id == self.session
            && active.session.running()
            && active.plan.monitors_node()
            && active.health.revision == self.revision
    }
}

pub struct Link {
    pub id: String,
    pub port: u16,
    pub controller: Controller,
    pub route_revision: u64,
    pub core: network::Core,
}

impl Supervisor {
    pub fn start(&self, plan: Plan) -> Result<(), String> {
        self.start_using(plan, Plan::start)
    }

    fn start_using(
        &self,
        plan: Plan,
        launch: impl FnOnce(&Plan) -> Result<network::Session, String>,
    ) -> Result<(), String> {
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
        let session = match launch(&plan) {
            Ok(session) => session,
            Err(error) => {
                slot.record("error", "网络进程启动失败");
                return Err(error);
            }
        };
        slot.active = Some(Running {
            session,
            plan,
            since: Instant::now(),
            failures: 0,
            retry_at: None,
            health: Health::default(),
        });
        slot.message = None;
        slot.record("info", "本地网络入口已就绪");
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        slot.message = None;
        let result = match slot.active.take() {
            Some(active) if active.session.running() => active.session.stop(),
            Some(_) => network::recover(),
            None => return Ok(()),
        };
        if result.is_ok() {
            slot.record("info", "已停止代理并结束网络接管");
        } else {
            slot.record("error", "代理已请求停止，网络设置恢复暂未确认");
        }
        result
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
                session_id: None,
                node_tag: None,
                node_health: None,
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
        let running = slot.active.as_ref().filter(|_| phase == "running");
        Status {
            phase,
            message,
            session_id: running.map(|active| active.session.id.clone()),
            node_tag: running
                .and_then(|active| active.plan.selected_node())
                .map(str::to_owned),
            node_health: running
                .filter(|active| active.plan.monitors_node())
                .map(|active| active.health.state.name()),
        }
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
                route_revision: active.health.revision,
                core: active.plan.core,
            }))
    }

    fn update_plan(
        &self,
        id: &str,
        event: &'static str,
        notice: Option<&'static str>,
        update: impl FnOnce(&mut Plan),
    ) -> bool {
        if let Ok(mut slot) = self.slot.lock() {
            if let Some(active) = slot
                .active
                .as_mut()
                .filter(|active| active.session.id == id)
            {
                update(&mut active.plan);
                active.health.reset();
                slot.message = notice;
                slot.record("info", event);
                return true;
            }
        }
        false
    }

    pub async fn switch_node(&self, tag: String) -> Result<(), String> {
        if !valid_tag(&tag) {
            return Err("节点标识无效".into());
        }
        let _guard = self.control.lock().await;
        let active = self
            .live()?
            .filter(|active| active.core == network::Core::Singbox)
            .ok_or("节点模式未运行")?;
        active.controller.switch(&tag).await?;
        if !self.update_plan(&active.id, "已切换代理节点", None, |plan| {
            plan.config["outbounds"][0]["default"] = tag.into();
        }) {
            return Err("代理会话已变化，请重新切换节点".into());
        }
        Ok(())
    }

    pub async fn mihomo_groups(&self) -> Result<Vec<crate::telemetry::ProxyGroup>, String> {
        let active = self
            .live()?
            .filter(|active| active.core == network::Core::Mihomo)
            .ok_or("Mihomo 原配置模式未运行")?;
        let groups = active.controller.groups().await?;
        if !self.live()?.is_some_and(|current| current.id == active.id) {
            return Err("Mihomo 会话已变化，请刷新策略组".into());
        }
        Ok(groups)
    }

    pub async fn switch_mihomo_group(&self, group: &str, choice: &str) -> Result<(), String> {
        let _guard = self.control.lock().await;
        let active = self
            .live()?
            .filter(|active| active.core == network::Core::Mihomo)
            .ok_or("Mihomo 原配置模式未运行")?;
        active.controller.switch_group(group, choice).await?;
        if !self.update_plan(&active.id, "已切换 Mihomo 策略组", None, |_| {}) {
            return Err("Mihomo 会话已变化，请重新选择".into());
        }
        Ok(())
    }

    pub async fn change_mode(&self, mode: network::RoutingMode) -> Result<(), String> {
        let _guard = self.control.lock().await;
        let active = self.live()?.ok_or("代理内核未运行")?;
        active.controller.routing_mode(mode.name()).await?;
        if !self.update_plan(&active.id, "已切换路由模式", None, |plan| {
            plan.routing_mode = mode
        }) {
            return Err("代理会话已变化，请重新切换路由模式".into());
        }
        Ok(())
    }

    pub async fn configure_failover(
        &self,
        enabled: bool,
        groups: Vec<Vec<String>>,
    ) -> Result<(), String> {
        let _guard = self.control.lock().await;
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        if let Some(active) = slot.active.as_mut().filter(|active| {
            active.plan.failover != enabled || active.plan.fallback_groups != groups
        }) {
            active.plan.failover = enabled;
            active.plan.fallback_groups = groups;
            active.health.reset();
        }
        Ok(())
    }

    fn node_check(&self) -> Option<NodeCheck> {
        let slot = self.slot.try_lock().ok()?;
        let active = slot.active.as_ref()?;
        if !active.session.running()
            || !active.plan.monitors_node()
            || Instant::now() < active.health.next_check
        {
            return None;
        }
        Some(NodeCheck {
            session: active.session.id.clone(),
            revision: active.health.revision,
            tag: active.plan.selected_node().unwrap_or("proxy").to_owned(),
            controller: active.session.controller.clone(),
        })
    }

    fn record_check(&self, check: &NodeCheck, result: Reachability) -> Vec<String> {
        let Ok(mut slot) = self.slot.lock() else {
            return Vec::new();
        };
        let Some(active) = slot
            .active
            .as_mut()
            .filter(|active| check.is_current(active))
        else {
            return Vec::new();
        };
        let previous = active.health.state;
        active.health.record(result);
        let down = active.health.state == Reachability::Unreachable;
        let candidates = if down {
            active
                .health
                .next_standbys(&active.plan.standbys(&check.tag))
        } else {
            Vec::new()
        };
        if down && previous != Reachability::Unreachable {
            slot.record("warn", "当前节点连续两次探测失败");
        }
        candidates
    }

    async fn check_node(&self, check: NodeCheck) {
        self.check_node_using(check, |controller, tag| async move {
            failover::probe(&controller, &tag).await
        })
        .await;
    }

    async fn check_node_using<P, F>(&self, check: NodeCheck, probe: P)
    where
        P: Fn(Controller, String) -> F,
        F: std::future::Future<Output = Reachability> + Send + 'static,
    {
        let result = probe(check.controller.clone(), check.tag.clone()).await;
        let candidates = self.record_check(&check, result);
        let mut search = tokio::task::JoinSet::new();
        for (priority, tag) in candidates.into_iter().enumerate() {
            let pending = probe(check.controller.clone(), tag.clone());
            search.spawn(async move { (priority, pending.await, tag) });
        }
        let mut best = None;
        while let Some(outcome) = search.join_next().await {
            if let Ok((priority, Reachability::Healthy, tag)) = outcome {
                if best.as_ref().is_none_or(|(index, _)| priority < *index) {
                    best = Some((priority, tag));
                }
            }
        }
        let Some((_, tag)) = best else { return };
        let _guard = self.control.lock().await;
        let current = self.slot.lock().ok().is_some_and(|slot| {
            slot.active
                .as_ref()
                .is_some_and(|active| check.is_current(active))
        });
        if current && check.controller.switch(&tag).await.is_ok() {
            self.update_plan(
                &check.session,
                "当前节点失联，已切换到同订阅的可用节点",
                Some("原节点失联，已自动换线"),
                |plan| {
                    plan.config["outbounds"][0]["default"] = tag.into();
                },
            );
        }
    }

    pub async fn watch_nodes(app: tauri::AppHandle) {
        use tauri::Manager;
        let state = app.state::<Self>();
        while !state.closing.load(Ordering::Acquire) {
            if let Some(check) = state.node_check() {
                state.check_node(check).await;
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    }

    pub fn events(&self) -> Result<Vec<Event>, String> {
        let slot = self
            .slot
            .try_lock()
            .map_err(|_| "代理正在处理网络状态，请稍后刷新")?;
        Ok(slot.events.iter().cloned().collect())
    }

    pub async fn watch_core_logs(app: tauri::AppHandle) {
        use tauri::Manager;
        let state = app.state::<Self>();
        while !state.closing.load(Ordering::Acquire) {
            let current = || {
                state.slot.try_lock().ok().and_then(|slot| {
                    slot.active
                        .as_ref()
                        .filter(|active| active.session.running())
                        .map(|active| active.session.id.clone())
                })
            };
            let link = state.slot.try_lock().ok().and_then(|slot| {
                slot.active
                    .as_ref()
                    .filter(|active| active.session.running())
                    .map(|active| (active.session.id.clone(), active.session.controller.clone()))
            });
            if let Some((id, controller)) = link {
                controller
                    .stream_logs(
                        || {
                            !state.closing.load(Ordering::Acquire)
                                && current().is_some_and(|current| current == id)
                        },
                        |level, message| {
                            if let Ok(mut slot) = state.slot.try_lock() {
                                let now = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs();
                                let duplicate = slot
                                    .events
                                    .iter()
                                    .rev()
                                    .take_while(|entry| now.saturating_sub(entry.timestamp) < 5)
                                    .any(|entry| entry.level == level && entry.message == message);
                                if !duplicate
                                    && slot
                                        .active
                                        .as_ref()
                                        .is_some_and(|active| active.session.id == id)
                                {
                                    slot.record(level, message);
                                }
                            }
                        },
                    )
                    .await;
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    }

    pub fn configure_recovery(&self, enabled: bool) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| "代理状态不可用")?;
        if let Some(active) = slot.active.as_mut() {
            active.plan.recover = enabled;
        }
        Ok(())
    }

    fn tick(&self) {
        self.tick_using(Plan::start);
    }

    fn tick_using(&self, launch: impl FnOnce(&Plan) -> Result<network::Session, String>) {
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
            let message = if network::recover().is_err() {
                "内核已退出，系统代理恢复暂未确认，请重新检查 Windows 代理设置"
            } else if tun {
                "TUN 内核已退出，重新连接时需要管理员授权"
            } else if exhausted {
                "自动恢复失败，已退出接管"
            } else {
                "内核意外退出，已恢复网络设置"
            };
            slot.message = Some(message);
            slot.record("warn", message);
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
        match launch(&active.plan) {
            Ok(session) => {
                active.session = session;
                active.since = Instant::now();
                active.health.reset();
                slot.message = Some("代理已自动恢复");
                slot.record("info", "检测到内核中断，代理已自动恢复");
            }
            Err(_) => slot.record("warn", "网络恢复尝试失败"),
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

    #[test]
    fn event_buffer_retains_latest_entries_in_order() {
        let mut slot = Slot::default();
        for _ in 0..165 {
            slot.record("info", "fixture");
        }
        assert_eq!(slot.events.len(), 160);
        assert_eq!(slot.events.front().unwrap().sequence, 6);
        assert_eq!(slot.events.back().unwrap().sequence, 165);
    }

    #[tokio::test]
    async fn installed_worker_switches_failed_node_and_keeps_the_same_session() {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            net::{TcpListener, TcpStream},
            path::PathBuf,
        };
        let Some(executable) = std::env::var_os("RELAYDESK_INSTALLED_SMOKE_APP").map(PathBuf::from)
        else {
            return;
        };
        let loopback = || TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let unavailable = loopback();
        let first = unavailable.local_addr().unwrap().port();
        let standby = loopback();
        standby.set_nonblocking(true).unwrap();
        let second = standby.local_addr().unwrap().port();
        let port = loopback().local_addr().unwrap().port();
        let supervisor = Supervisor::default();
        let plan = Plan {
            core: network::Core::Singbox,
            config: serde_json::json!({
                "inbounds":[{"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port}],
                "outbounds":[
                    {"type":"selector","tag":"proxy","outbounds":["node-0","node-1"],"default":"node-0","interrupt_exist_connections":false},
                    {"type":"http","tag":"node-0","server":"127.0.0.1","server_port":first},
                    {"type":"http","tag":"node-1","server":"127.0.0.1","server_port":second},
                    {"type":"direct","tag":"direct"}
                ],
                "route":{"rules":[],"final":"proxy"}
            }),
            port,
            mode: "local".into(),
            routing_mode: network::RoutingMode::Global,
            recover: true,
            failover: true,
            fallback_groups: vec![vec!["node-0".into(), "node-1".into()]],
        };
        supervisor
            .start_using(plan, |plan| {
                network::Session::start_using(
                    plan.config.clone(),
                    plan.port,
                    &plan.mode,
                    plan.routing_mode,
                    plan.core,
                    &executable,
                )
            })
            .unwrap();
        let original = supervisor.status().session_id.unwrap();
        let next_check = || {
            supervisor
                .slot
                .lock()
                .unwrap()
                .active
                .as_mut()
                .unwrap()
                .health
                .next_check = Instant::now();
            supervisor.node_check().unwrap()
        };
        let probe = |_, tag: String| async move {
            if tag == "node-1" {
                Reachability::Healthy
            } else {
                Reachability::Unreachable
            }
        };
        supervisor.check_node_using(next_check(), probe).await;
        assert_eq!(supervisor.status().node_tag.as_deref(), Some("node-0"));
        supervisor.check_node_using(next_check(), probe).await;
        let status = supervisor.status();
        assert_eq!(status.node_tag.as_deref(), Some("node-1"));
        assert_eq!(status.session_id.as_deref(), Some(original.as_str()));
        assert_eq!(status.message, Some("原节点失联，已自动换线"));

        let upstream = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut socket = loop {
                match standby.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(error) => panic!("standby proxy was never reached: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            fn headers(socket: &mut TcpStream) -> String {
                let mut reader = BufReader::new(socket);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                for line in reader.lines() {
                    if line.unwrap().is_empty() {
                        break;
                    }
                }
                first
            }
            assert!(headers(&mut socket).starts_with("CONNECT fixture.test:80 "));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            assert!(headers(&mut socket).starts_with("GET /hello "));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 7\r\n\r\nstandby",
                )
                .unwrap();
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(b"GET http://fixture.test/hello HTTP/1.1\r\nHost: fixture.test\r\nConnection: close\r\n\r\n").unwrap();
        let mut body = String::new();
        client.read_to_string(&mut body).unwrap();
        upstream.join().unwrap();
        assert!(body.ends_with("standby"));

        let stale = next_check();
        supervisor.switch_node("node-0".into()).await.unwrap();
        supervisor
            .check_node_using(stale, |_, _| async { Reachability::Unreachable })
            .await;
        assert_eq!(supervisor.status().node_tag.as_deref(), Some("node-0"));
        supervisor
            .change_mode(network::RoutingMode::Direct)
            .await
            .unwrap();
        assert!(supervisor.status().node_health.is_none());
        assert!(supervisor.node_check().is_none());
        supervisor.stop().unwrap();
        assert_eq!(supervisor.status().phase, "stopped");
    }

    #[test]
    fn installed_worker_recovers_and_explicit_stop_cancels_it() {
        use std::{
            io::{Read, Write},
            net::{TcpListener, TcpStream},
            path::PathBuf,
        };
        let Some(executable) = std::env::var_os("RELAYDESK_INSTALLED_SMOKE_APP").map(PathBuf::from)
        else {
            return;
        };
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let supervisor = Supervisor::default();
        let launch = |plan: &Plan| {
            network::Session::start_using(
                plan.config.clone(),
                plan.port,
                &plan.mode,
                plan.routing_mode,
                plan.core,
                &executable,
            )
        };
        let plan = Plan {
            core: network::Core::Singbox,
            config: serde_json::json!({
                "inbounds":[{"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port}],
                "outbounds":[
                    {"type":"vless","tag":"proxy","server":"127.0.0.1","server_port":9,"uuid":"00000000-0000-4000-8000-000000000000"},
                    {"type":"direct","tag":"direct"}
                ],
                "route":{"rules":[],"final":"direct","auto_detect_interface":true}
            }),
            port,
            mode: "local".into(),
            routing_mode: network::RoutingMode::Rule,
            recover: true,
            failover: false,
            fallback_groups: Vec::new(),
        };
        let check_listener = || {
            let endpoint = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            endpoint.set_nonblocking(true).unwrap();
            let endpoint_port = endpoint.local_addr().unwrap().port();
            let echo = thread::spawn(move || {
                let until = Instant::now() + Duration::from_secs(5);
                while Instant::now() < until {
                    if let Ok((mut client, _)) = endpoint.accept() {
                        client
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut buffer = [0; 4096];
                        let _ = client.read(&mut buffer);
                        let _ = client.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 4\r\n\r\nokay");
                        return;
                    }
                    thread::sleep(Duration::from_millis(30));
                }
            });
            let mut proxy = TcpStream::connect(("127.0.0.1", port)).unwrap();
            proxy
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            write!(proxy,"GET http://127.0.0.1:{endpoint_port}/ HTTP/1.1\r\nHost: 127.0.0.1:{endpoint_port}\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new();
            proxy.read_to_string(&mut response).unwrap();
            echo.join().unwrap();
            assert!(response.ends_with("okay"), "{response}");
        };
        supervisor.start_using(plan, launch).unwrap();
        check_listener();
        let before = supervisor.live().unwrap().unwrap().id;
        supervisor
            .slot
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .session
            .kill_fixture_worker();
        assert_eq!(supervisor.status().phase, "recovering");
        supervisor.tick_using(launch);
        thread::sleep(Duration::from_millis(1200));
        supervisor.tick_using(launch);
        assert_ne!(supervisor.live().unwrap().unwrap().id, before);
        check_listener();
        supervisor.stop().unwrap();
        supervisor.tick_using(|_| panic!("an explicit stop started a new worker"));
        assert_eq!(supervisor.status().phase, "stopped");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
}
