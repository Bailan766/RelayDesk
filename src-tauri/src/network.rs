use crate::{core_command, core_path, mihomo, system_proxy};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    ptr, thread,
    time::{Duration, Instant},
};
use std::{
    net::{SocketAddr, TcpListener, TcpStream, UdpSocket},
    os::windows::io::AsRawHandle,
    process::{Child, Stdio},
};
use winapi::{
    shared::minwindef::{FALSE, TRUE},
    um::{
        handleapi::CloseHandle,
        jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
        processthreadsapi::{GetProcessId, OpenProcess},
        shellapi::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        synchapi::{
            CreateEventW, CreateMutexW, OpenEventW, ReleaseMutex, SetEvent, WaitForSingleObject,
        },
        winbase::{WAIT_ABANDONED, WAIT_OBJECT_0},
        winnt::{
            JobObjectExtendedLimitInformation, EVENT_MODIFY_STATE, HANDLE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SYNCHRONIZE,
        },
    },
};

const APPLY_TIMEOUT: Duration = Duration::from_secs(15);
const TUN_READY_TIMEOUT: Duration = Duration::from_secs(20);
const MIHOMO_READY_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Copy, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Core {
    #[default]
    Singbox,
    Mihomo,
    Bridge,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct CoreSettings {
    pub config: Value,
    #[serde(default)]
    pub core: Core,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub selections: BTreeMap<String, String>,
}

impl CoreSettings {
    pub fn singbox(config: Value) -> Self {
        Self {
            config,
            core: Core::Singbox,
            selections: BTreeMap::new(),
        }
    }
}

fn tun_interface(token: &str) -> String {
    format!("RelayDesk-{}", &token[..12])
}

#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingMode {
    #[default]
    Rule,
    Global,
    Direct,
}

impl RoutingMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::Global => "global",
            Self::Direct => "direct",
        }
    }
}

struct Handle(HANDLE);
unsafe impl Send for Handle {}

impl Handle {
    fn new(handle: HANDLE) -> Result<Self, String> {
        if handle.is_null() {
            Err("无法打开 Windows 进程或同步对象".into())
        } else {
            Ok(Self(handle))
        }
    }

    fn signaled(&self, timeout: u32) -> bool {
        unsafe { WaitForSingleObject(self.0, timeout) == WAIT_OBJECT_0 }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}

fn event_name(token: &str, name: &str) -> Vec<u16> {
    wide(format!("Local\\RelayDesk.{token}.{name}"))
}

fn runtime_dir() -> Result<PathBuf, String> {
    let path = PathBuf::from(env::var_os("LOCALAPPDATA").ok_or("无法定位本地数据目录")?)
        .join("RelayDesk")
        .join("network-state");
    fs::create_dir_all(&path).map_err(|_| "无法创建网络状态目录")?;
    Ok(path)
}

struct NetworkLock(Handle);

impl NetworkLock {
    fn acquire() -> Result<Self, String> {
        Self::named("Local\\RelayDesk.Network")
    }

    fn policy() -> Result<Self, String> {
        Self::named("Local\\RelayDesk.TunPolicy")
    }

    fn named(name: &str) -> Result<Self, String> {
        let name = wide(name);
        let handle = Handle::new(unsafe { CreateMutexW(ptr::null_mut(), FALSE, name.as_ptr()) })?;
        match unsafe { WaitForSingleObject(handle.0, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            _ => Err("另一个 RelayDesk 会话正在管理网络".into()),
        }
    }
}

impl Drop for NetworkLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

pub fn recover() -> Result<(), String> {
    let _lock = NetworkLock::acquire()?;
    let directory = runtime_dir()?;
    if let Ok(_policy) = NetworkLock::policy() {
        for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
            let filename = entry.file_name();
            if filename
                .to_str()
                .and_then(|name| name.strip_prefix("mihomo-"))
                .is_some_and(|token| {
                    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    system_proxy::recover(&directory.join("proxy.json"))
        .map_err(|_| "恢复上次系统代理设置失败".into())
}

fn checked_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .filter(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}

fn string_list(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn validate_tls(value: &Value) -> Option<()> {
    let tls = checked_object(
        value,
        &[
            "enabled",
            "server_name",
            "insecure",
            "disable_sni",
            "alpn",
            "min_version",
            "max_version",
            "certificate_public_key_sha256",
            "utls",
            "reality",
        ],
    )?;
    for (key, value) in tls {
        let valid = match key.as_str() {
            "enabled" | "insecure" | "disable_sni" => value.is_boolean(),
            "alpn" | "certificate_public_key_sha256" => string_list(value),
            "utls" | "reality" => {
                let allowed: &[&str] = if key == "utls" {
                    &["enabled", "fingerprint"]
                } else {
                    &["enabled", "public_key", "short_id"]
                };
                checked_object(value, allowed).is_some_and(|fields| {
                    fields.iter().all(|(key, value)| {
                        if key == "enabled" {
                            value.is_boolean()
                        } else {
                            value.is_string()
                        }
                    })
                })
            }
            _ => value.is_string(),
        };
        if !valid {
            return None;
        }
    }
    Some(())
}

fn validate_transport(value: &Value) -> Option<()> {
    let allowed: &[&str] = match value.get("type")?.as_str()? {
        "ws" => &[
            "type",
            "path",
            "headers",
            "max_early_data",
            "early_data_header_name",
        ],
        "grpc" => &["type", "service_name"],
        "httpupgrade" => &["type", "host", "path"],
        _ => return None,
    };
    checked_object(value, allowed)?
        .iter()
        .all(|(key, value)| match key.as_str() {
            "headers" => checked_object(value, &["Host"])
                .is_some_and(|headers| headers.values().all(Value::is_string)),
            "max_early_data" => value.is_u64(),
            _ => value.is_string(),
        })
        .then_some(())
}

fn validate_node(node: &Value, tag: &str) -> Option<()> {
    let fields = node.as_object()?;
    let common = ["type", "tag", "server", "server_port", "network"];
    let specific: &[&str] = match node.get("type")?.as_str()? {
        "vless" => &["uuid", "flow", "packet_encoding", "transport", "tls"],
        "vmess" => &[
            "uuid",
            "security",
            "alter_id",
            "global_padding",
            "authenticated_length",
            "packet_encoding",
            "transport",
            "tls",
        ],
        "trojan" => &["password", "transport", "tls"],
        "shadowsocks" => &[
            "method",
            "password",
            "plugin",
            "plugin_opts",
            "udp_over_tcp",
        ],
        "hysteria2" => &[
            "password",
            "server_ports",
            "hop_interval",
            "up_mbps",
            "down_mbps",
            "obfs",
            "tls",
        ],
        "tuic" => &[
            "uuid",
            "password",
            "congestion_control",
            "udp_relay_mode",
            "udp_over_stream",
            "zero_rtt_handshake",
            "heartbeat",
            "tls",
        ],
        _ => return None,
    };
    if node.get("tag")?.as_str()? != tag || node.get("server")?.as_str()?.is_empty() {
        return None;
    }
    for (key, value) in fields {
        if !common.contains(&key.as_str()) && !specific.contains(&key.as_str()) {
            return None;
        }
        let valid = match key.as_str() {
            "tls" => validate_tls(value).is_some(),
            "transport" => validate_transport(value).is_some(),
            "server_ports" => string_list(value),
            "network" => matches!(value.as_str(), Some("tcp" | "udp")),
            "server_port" => value
                .as_u64()
                .is_some_and(|port| (1..=65535).contains(&port)),
            "up_mbps" | "down_mbps" | "alter_id" => value.is_u64(),
            "global_padding"
            | "authenticated_length"
            | "udp_over_tcp"
            | "udp_over_stream"
            | "zero_rtt_handshake" => value.is_boolean(),
            "plugin" => matches!(value.as_str(), Some("obfs-local" | "v2ray-plugin")),
            "plugin_opts" => {
                fields.contains_key("plugin")
                    && value.as_str().is_some_and(|options| {
                        options.split(';').all(|option| {
                            option.is_empty()
                                || option == "tls"
                                || option.split_once('=').is_some_and(|(key, value)| {
                                    matches!(key, "mode" | "host" | "path" | "obfs" | "obfs-host")
                                        && !value.contains(['\r', '\n'])
                                })
                        })
                    })
            }
            "obfs" => checked_object(value, &["type", "password"]).is_some_and(|obfs| {
                obfs.get("type").and_then(Value::as_str) == Some("salamander")
                    && obfs
                        .get("password")
                        .and_then(Value::as_str)
                        .is_some_and(|password| !password.is_empty())
            }),
            _ => value.is_string(),
        };
        if !valid {
            return None;
        }
    }
    Some(())
}

fn valid_cidr(text: &str) -> bool {
    text.split_once('/').is_some_and(|(address, prefix)| {
        let limit = match address.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(_)) => 32,
            Ok(std::net::IpAddr::V6(_)) => 128,
            _ => return false,
        };
        prefix.parse::<u8>().is_ok_and(|prefix| prefix <= limit)
    })
}

fn valid_wireguard_prefixes(value: &Value) -> bool {
    value.as_array().is_some_and(|prefixes| {
        !prefixes.is_empty()
            && prefixes.len() <= 64
            && prefixes
                .iter()
                .all(|prefix| prefix.as_str().is_some_and(valid_cidr))
    })
}

fn valid_wireguard_key(value: &Value) -> bool {
    value.as_str().is_some_and(|key| {
        key.len() == 44
            && key.ends_with('=')
            && key.as_bytes()[..43]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    })
}

fn validate_endpoint(endpoint: &Value, tag: &str) -> Option<()> {
    let fields = checked_object(
        endpoint,
        &[
            "type",
            "tag",
            "system",
            "detour",
            "address",
            "private_key",
            "mtu",
            "peers",
        ],
    )?;
    if fields.get("tag")?.as_str()? != tag
        || fields.get("type")?.as_str()? != "wireguard"
        || fields.get("system")?.as_bool()?
        || fields.get("detour")?.as_str()? != "wireguard-uplink"
        || !valid_wireguard_prefixes(fields.get("address")?)
        || !valid_wireguard_key(fields.get("private_key")?)
        || fields.get("mtu").is_some_and(|value| {
            !value
                .as_u64()
                .is_some_and(|mtu| (576..=65535).contains(&mtu))
        })
    {
        return None;
    }
    let peers = fields.get("peers")?.as_array()?;
    if peers.is_empty() || peers.len() > 32 {
        return None;
    }
    for peer in peers {
        let fields = checked_object(
            peer,
            &[
                "address",
                "port",
                "public_key",
                "pre_shared_key",
                "allowed_ips",
                "reserved",
                "persistent_keepalive_interval",
            ],
        )?;
        let address = fields.get("address")?.as_str()?;
        if address.is_empty()
            || address.len() > 253
            || !address.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
            })
            || !fields
                .get("port")?
                .as_u64()
                .is_some_and(|port| (1..=65535).contains(&port))
            || !valid_wireguard_key(fields.get("public_key")?)
            || !valid_wireguard_prefixes(fields.get("allowed_ips")?)
            || fields
                .get("pre_shared_key")
                .is_some_and(|value| !valid_wireguard_key(value))
            || fields
                .get("persistent_keepalive_interval")
                .is_some_and(|value| !value.as_u64().is_some_and(|n| n <= 65535))
            || fields.get("reserved").is_some_and(|value| {
                !value.as_array().is_some_and(|bytes| {
                    bytes.len() == 3
                        && bytes
                            .iter()
                            .all(|byte| byte.as_u64().is_some_and(|n| n <= 255))
                })
            })
        {
            return None;
        }
    }
    Some(())
}

fn validate_outbounds(outbounds: &[Value], endpoints: &[Value]) -> Option<()> {
    let (direct, group) = outbounds.split_last()?;
    if *direct != json!({"type":"direct","tag":"direct"}) {
        return None;
    }
    let group = if endpoints.is_empty() {
        group
    } else {
        let (uplink, group) = group.split_last()?;
        if endpoints.len() > 32
            || *uplink != json!({"type":"direct","tag":"wireguard-uplink","connect_timeout":"5s"})
        {
            return None;
        }
        group
    };
    if let [node] = group {
        if endpoints.is_empty() && node.get("type").and_then(Value::as_str) != Some("selector") {
            return validate_node(node, "proxy");
        }
    }
    let (selector, nodes) = group.split_first()?;
    let selector = checked_object(
        selector,
        &[
            "type",
            "tag",
            "outbounds",
            "default",
            "interrupt_exist_connections",
        ],
    )?;
    if selector.get("type")?.as_str()? != "selector"
        || selector.get("tag")?.as_str()? != "proxy"
        || selector.get("interrupt_exist_connections")?.as_bool()?
        || nodes.len() + endpoints.len() > 2048
    {
        return None;
    }
    let tags = selector.get("outbounds")?.as_array()?;
    let default = selector.get("default")?.as_str()?;
    if tags.len() != nodes.len() + endpoints.len()
        || !tags.iter().any(|tag| tag.as_str() == Some(default))
    {
        return None;
    }
    let mut tagged = std::collections::HashMap::new();
    for (node, is_endpoint) in nodes
        .iter()
        .map(|node| (node, false))
        .chain(endpoints.iter().map(|node| (node, true)))
    {
        if tagged
            .insert(node.get("tag")?.as_str()?, (node, is_endpoint))
            .is_some()
        {
            return None;
        }
    }
    for (index, tag) in tags.iter().enumerate() {
        let expected = format!("node-{index}");
        if tag.as_str()? != expected {
            return None;
        }
        let (node, is_endpoint) = tagged.remove(expected.as_str())?;
        if is_endpoint {
            validate_endpoint(node, &expected)?;
        } else {
            validate_node(node, &expected)?;
        }
    }
    Some(())
}

fn validate_rule(rule: &Value, outbounds: &[Value], endpoints: &[Value]) -> Option<()> {
    const MATCHES: [&str; 4] = ["domain", "domain_suffix", "ip_cidr", "process_path_regex"];
    let fields = checked_object(
        rule,
        &[
            "domain",
            "domain_suffix",
            "ip_cidr",
            "process_path_regex",
            "outbound",
            "action",
        ],
    )?;
    let mut selectors = MATCHES
        .into_iter()
        .filter_map(|key| fields.get(key).map(|value| (key, value)));
    let (key, values) = selectors.next()?;
    if selectors.next().is_some() {
        return None;
    }
    let values = values.as_array()?;
    if values.is_empty()
        || !values.iter().all(|value| {
            let Some(text) = value.as_str() else {
                return false;
            };
            match key {
                "ip_cidr" => valid_cidr(text),
                "process_path_regex" => {
                    text.len() <= 512 && text.starts_with("(?i)(?:^|[") && text.ends_with('$')
                }
                _ => !text.is_empty() && text.len() <= 253,
            }
        })
    {
        return None;
    }
    match (fields.get("action"), fields.get("outbound")) {
        (Some(action), None) if action.as_str() == Some("reject") => Some(()),
        (None, Some(outbound))
            if outbound.as_str() != Some("wireguard-uplink")
                && outbounds.iter().chain(endpoints).any(|item| {
                    item.get("tag").and_then(Value::as_str) == outbound.as_str()
                        && outbound.is_string()
                }) =>
        {
            Some(())
        }
        _ => None,
    }
}

// The elevated worker constructs its own inbound, DNS and interface settings.
fn tun_config(config: &Value, port: u16, interface_name: &str) -> Option<Value> {
    let root = checked_object(
        config,
        &["log", "inbounds", "outbounds", "endpoints", "route", "dns"],
    )?;
    let outbounds = root.get("outbounds")?.as_array()?;
    let endpoints: &[Value] = match root.get("endpoints") {
        Some(list) => list.as_array()?,
        None => &[],
    };
    validate_outbounds(outbounds, endpoints)?;
    let route = checked_object(
        root.get("route")?,
        &[
            "rules",
            "final",
            "auto_detect_interface",
            "default_domain_resolver",
        ],
    )?;
    let mut rules = route.get("rules")?.as_array()?.as_slice();
    let mut output_rules = vec![
        json!({"action":"sniff"}),
        json!({"protocol":"dns","action":"hijack-dns"}),
    ];
    if !endpoints.is_empty() {
        let (front, rest) = rules.split_first()?;
        let tags: Vec<_> = endpoints.iter().map(|endpoint| &endpoint["tag"]).collect();
        let guard = json!({"inbound":tags,"action":"reject"});
        if *front != guard {
            return None;
        }
        output_rules.insert(0, guard);
        rules = rest;
    }
    for rule in rules {
        validate_rule(rule, outbounds, endpoints)?;
        output_rules.push(rule.clone());
    }
    Some(json!({
        "log": {"level":"warn"},
        "inbounds": [
            {"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port},
            {"type":"tun","tag":"tun","interface_name":interface_name,"address":["172.28.254.1/30","fdfe:dcba:9876::1/126"],"auto_route":true,"strict_route":true,"stack":"mixed"}
        ],
        "outbounds": outbounds,
        "endpoints": endpoints,
        "route":{"rules":output_rules,"final":"proxy","auto_detect_interface":true,"default_domain_resolver":"bootstrap"},
        "dns":{
            "servers":[{"type":"local","tag":"bootstrap"},{"type":"https","tag":"remote","server":"1.1.1.1","path":"/dns-query","detour":"proxy"}],
            "rules":[{"clash_mode":"direct","action":"route","server":"bootstrap"}],
            "final":"remote"
        }
    }))
}

pub struct Session {
    worker: Handle,
    stop: Handle,
    pub port: u16,
    pub controller: crate::telemetry::Controller,
    pub id: String,
    pub policy_dns: Option<u16>,
    policy: Option<Box<Session>>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct WorkerInput {
    #[serde(flatten)]
    settings: CoreSettings,
    controller: crate::telemetry::Controller,
    #[serde(default)]
    routing_mode: RoutingMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy_dns: Option<u16>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureTarget {
    mixed_port: u16,
    dns_port: u16,
    policy_pid: u32,
}

fn capture_config(
    target: &CaptureTarget,
    port: u16,
    interface: &str,
    program: &std::path::Path,
) -> Value {
    let path = program.to_string_lossy();
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
    let mut expression = String::from("(?i)^");
    for character in path.chars() {
        if r"\.^$|?*+()[]{}".contains(character) {
            expression.push('\\');
        }
        expression.push(character);
    }
    expression.push('$');
    json!({
        "log":{"level":"warn"},
        "inbounds":[
            {"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port},
            {"type":"tun","tag":"tun","interface_name":interface,"address":["172.28.254.1/30","fdfe:dcba:9876::1/126"],
             "auto_route":true,"strict_route":true,"stack":"mixed"}
        ],
        "outbounds":[
            {"type":"socks","tag":"policy","server":"127.0.0.1","server_port":target.mixed_port,"version":"5"},
            {"type":"direct","tag":"physical"}
        ],
        "route":{"auto_detect_interface":true,"final":"policy","rules":[
            {"process_path_regex":[expression],"outbound":"physical"},
            {"action":"sniff"},
            {"protocol":"dns","action":"hijack-dns"}
        ]},
        "dns":{"servers":[{"type":"udp","tag":"policy-dns","server":"127.0.0.1","server_port":target.dns_port}],"final":"policy-dns"}
    })
}

struct MihomoHome(PathBuf);
impl Drop for MihomoHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Session {
    pub fn start(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
    ) -> Result<Self, String> {
        let executable = env::current_exe().map_err(|_| "无法定位当前应用")?;
        Self::start_using(settings, port, mode, routing_mode, &executable)
    }

    pub(crate) fn start_using(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        executable: &std::path::Path,
    ) -> Result<Self, String> {
        if !matches!(mode, "local" | "system" | "tun") {
            return Err("代理入口模式无效".into());
        }
        if settings.core == Core::Mihomo && mode == "tun" {
            let dns_port = auxiliary_port(&[port])?;
            mihomo::prepare_tun_policy(&settings.config, port, routing_mode, dns_port)?;
            let policy = Self::start_worker(
                settings,
                port,
                "policy",
                routing_mode,
                executable,
                Some(dns_port),
            )?;
            let policy_pid = unsafe { GetProcessId(policy.worker.0) };
            if policy_pid == 0 {
                return Err("无法监视 Mihomo 网络进程".into());
            }
            let local_port = auxiliary_port(&[port, dns_port])?;
            let target = CaptureTarget {
                mixed_port: port,
                dns_port,
                policy_pid,
            };
            let settings = CoreSettings {
                core: Core::Bridge,
                config: serde_json::to_value(target).map_err(|_| "TUN 转发设置无效")?,
                selections: BTreeMap::new(),
            };
            let mut capture = Self::start_worker(
                settings,
                local_port,
                "tun",
                RoutingMode::Rule,
                executable,
                None,
            )?;
            capture.port = port;
            capture.controller = policy.controller.clone();
            capture.policy_dns = Some(dns_port);
            capture.policy = Some(Box::new(policy));
            return Ok(capture);
        }
        if settings.core == Core::Mihomo {
            mihomo::prepare(&settings.config, port, routing_mode)?;
        }
        Self::start_worker(settings, port, mode, routing_mode, executable, None)
    }

    fn start_worker(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        executable: &std::path::Path,
        policy_dns: Option<u16>,
    ) -> Result<Self, String> {
        let core = settings.core;
        ensure_port_available(port)?;
        let directory = runtime_dir()?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let ready = Handle::new(unsafe {
            CreateEventW(
                ptr::null_mut(),
                TRUE,
                FALSE,
                event_name(&token, "ready").as_ptr(),
            )
        })?;
        let stop = Handle::new(unsafe {
            CreateEventW(
                ptr::null_mut(),
                TRUE,
                FALSE,
                event_name(&token, "stop").as_ptr(),
            )
        })?;
        let path = directory.join(format!("{token}.json"));
        let _cleanup = crate::TemporaryConfig(path.clone());
        let controller = crate::telemetry::Controller::new(port)?;
        let input = WorkerInput {
            settings,
            controller: controller.clone(),
            routing_mode,
            policy_dns,
        };
        fs::write(
            &path,
            serde_json::to_vec(&input).map_err(|_| "代理配置无效")?,
        )
        .map_err(|_| "无法写入代理配置")?;
        let executable = wide(executable.as_os_str());
        let parameters = wide(format!(
            "--network-worker {} {token} {port} {mode}",
            std::process::id()
        ));
        let verb = wide(if mode == "tun" { "runas" } else { "open" });
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = executable.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = 0;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            return Err(if mode == "tun" {
                "TUN 需要使用同一 Windows 用户授权管理员权限"
            } else {
                "无法启动网络守护进程"
            }
            .into());
        }
        let session = Self {
            worker: Handle::new(info.hProcess)?,
            stop,
            port,
            controller,
            id: token,
            policy_dns,
            policy: None,
        };
        let deadline = Instant::now()
            + if core == Core::Mihomo {
                MIHOMO_READY_TIMEOUT + Duration::from_secs(5)
            } else if mode == "tun" {
                TUN_READY_TIMEOUT + Duration::from_secs(5)
            } else {
                APPLY_TIMEOUT
            };
        while Instant::now() < deadline {
            if ready.signaled(40) && session.running() {
                return Ok(session);
            }
            if !session.running() {
                break;
            }
        }
        Err(if core == Core::Mihomo {
            "Mihomo 原配置检查或启动失败，请检查配置、提供者和本地端口"
        } else if mode == "tun" {
            "TUN 启动失败，请检查管理员权限、虚拟网卡或 DNS 配置"
        } else {
            "代理启动失败，请检查内核、端口或 Windows 代理设置"
        }
        .into())
    }

    pub fn running(&self) -> bool {
        !self.worker.signaled(0) && self.policy.as_ref().is_none_or(|policy| policy.running())
    }

    #[cfg(test)]
    pub fn kill_fixture_worker(&self) {
        use winapi::um::processthreadsapi::TerminateProcess;
        assert_ne!(unsafe { TerminateProcess(self.worker.0, 1) }, 0);
        assert!(self.worker.signaled(5000));
    }

    pub fn stop(mut self) -> Result<(), String> {
        let capture = self.stop_worker();
        let policy = self
            .policy
            .take()
            .map(|policy| policy.stop_worker())
            .unwrap_or(Ok(()));
        capture.and(policy)
    }

    fn stop_worker(&self) -> Result<(), String> {
        unsafe {
            SetEvent(self.stop.0);
        }
        if self.worker.signaled(4500) {
            let mut code = 1;
            if unsafe {
                winapi::um::processthreadsapi::GetExitCodeProcess(self.worker.0, &mut code)
            } != 0
                && code == 0
            {
                return Ok(());
            }
        }
        Err("无法确认网络设置已恢复，请重开 RelayDesk 检查".into())
    }
}

fn auxiliary_port(excluded: &[u16]) -> Result<u16, String> {
    for _ in 0..16 {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|_| "无法分配内部 TUN 端口")?
            .port();
        if port >= 1024 && !excluded.contains(&port) && ensure_port_available(port).is_ok() {
            return Ok(port);
        }
    }
    Err("无法找到可用的内部 TUN 端口".into())
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            SetEvent(self.stop.0);
        }
    }
}

fn job() -> Result<Handle, String> {
    let job = Handle::new(unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err("无法设置 Windows 进程回收".into());
    }
    Ok(job)
}

fn assign(child: &mut Child, job: &Handle) -> Result<(), String> {
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle().cast()) } == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("无法加入 Windows 进程回收组".into());
    }
    Ok(())
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    let busy = |_| format!("本地端口 {port} 已被占用，请在设置中更换端口或改为自动分配");
    let _tcp = TcpListener::bind(("127.0.0.1", port)).map_err(busy)?;
    let _udp = UdpSocket::bind(("127.0.0.1", port)).map_err(busy)?;
    Ok(())
}

fn add_routing_modes(config: &mut Value, tun: bool) -> Option<()> {
    let has_wireguard = config
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|endpoints| !endpoints.is_empty());
    let route = config
        .as_object_mut()?
        .entry("route")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let fallback = route
        .get("final")
        .and_then(Value::as_str)
        .unwrap_or("proxy")
        .to_owned();
    let rules = route
        .entry("rules")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    let first = if tun { 2 } else { 0 } + usize::from(has_wireguard);
    rules.splice(
        first..first,
        [
            json!({"clash_mode":"direct","outbound":"direct"}),
            json!({"clash_mode":"global","outbound":"proxy"}),
        ],
    );
    rules.push(json!({"clash_mode":"rule","outbound":fallback}));
    Some(())
}

fn run_worker(args: &[String]) -> Result<(), String> {
    let [parent, token, port, mode] = args else {
        return Err("网络参数无效".into());
    };
    let parent_id: u32 = parent.parse().map_err(|_| "父进程无效")?;
    let port: u16 = port.parse().map_err(|_| "端口无效")?;
    if token.len() != 32
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
        || port < 1024
        || !matches!(mode.as_str(), "local" | "system" | "tun" | "policy")
    {
        return Err("网络参数无效".into());
    }
    let parent = Handle::new(unsafe { OpenProcess(SYNCHRONIZE, FALSE, parent_id) })?;
    let stop =
        Handle::new(unsafe { OpenEventW(SYNCHRONIZE, FALSE, event_name(token, "stop").as_ptr()) })?;
    let ready = Handle::new(unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE,
            FALSE,
            event_name(token, "ready").as_ptr(),
        )
    })?;
    let _lock = if mode == "policy" {
        NetworkLock::policy()?
    } else {
        NetworkLock::acquire()?
    };
    let directory = runtime_dir()?;
    let journal = directory.join("proxy.json");
    if mode != "policy" {
        system_proxy::recover(&journal).map_err(|_| "恢复系统代理失败")?;
    }
    ensure_port_available(port)?;
    let input = directory.join(format!("{token}.json"));
    let config = fs::read(input).map_err(|_| "无法读取内核配置")?;
    let WorkerInput {
        settings:
            CoreSettings {
                mut config,
                core,
                selections,
            },
        controller,
        routing_mode,
        policy_dns,
    } = serde_json::from_slice(&config).map_err(|_| "内核配置无效")?;
    if (mode == "policy" && (core != Core::Mihomo || policy_dns.is_none()))
        || (mode != "policy" && policy_dns.is_some())
        || (core == Core::Bridge && mode != "tun")
    {
        return Err("TUN 转发参数不符合入口类型".into());
    }
    let mut dependency = None;
    let home = if core == Core::Mihomo {
        if mode == "tun" {
            return Err("Mihomo 原配置不能由 TUN 提权进程加载".into());
        }
        config = if let Some(dns) = policy_dns {
            if dns < 1024 || dns == port {
                return Err("Mihomo DNS 端口无效".into());
            }
            ensure_port_available(dns)?;
            mihomo::prepare_tun_policy(&config, port, routing_mode, dns)?
        } else {
            mihomo::prepare(&config, port, routing_mode)?
        };
        controller.configure_mihomo(&mut config);
        let path = directory.join(format!("mihomo-{token}"));
        fs::create_dir(&path).map_err(|_| "无法创建 Mihomo 工作目录")?;
        Some(MihomoHome(path))
    } else if core == Core::Bridge {
        let target: CaptureTarget =
            serde_json::from_value(config).map_err(|_| "TUN 转发目标无效")?;
        if target.mixed_port < 1024
            || target.dns_port < 1024
            || target.mixed_port == target.dns_port
            || [target.mixed_port, target.dns_port].contains(&port)
            || target.policy_pid == 0
            || target.policy_pid == std::process::id()
            || target.policy_pid == parent_id
        {
            return Err("TUN 转发端口或进程无效".into());
        }
        dependency = Some(Handle::new(unsafe {
            OpenProcess(SYNCHRONIZE, FALSE, target.policy_pid)
        })?);
        let program = crate::bundled_binary("mihomo.exe")?;
        config = capture_config(&target, port, &tun_interface(token), &program);
        None
    } else {
        if mode == "tun" {
            config = tun_config(&config, port, &tun_interface(token)).ok_or("TUN 配置无效")?;
        }
        add_routing_modes(&mut config, mode == "tun").ok_or("无法配置路由模式")?;
        controller.configure(&mut config, routing_mode.name());
        None
    };
    let binary = match core {
        Core::Singbox | Core::Bridge => core_path()?,
        Core::Mihomo => crate::bundled_binary("mihomo.exe")?,
    };
    let config = serde_json::to_vec(&config).map_err(|_| "内核配置无效")?;
    let job = job()?;
    let config_command = |check: bool| {
        let mut command = core_command(&binary);
        if let Some(home) = &home {
            if check {
                command.arg("-t");
            }
            command
                .arg("-d")
                .arg(&home.0)
                .args(["-f", "-"])
                .env_remove("SAFE_PATHS")
                .env_remove("SKIP_SAFE_PATH_CHECK");
        } else {
            command.args([if check { "check" } else { "run" }, "-c", "stdin"]);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    };
    let deadline = Instant::now()
        + if core == Core::Mihomo {
            MIHOMO_READY_TIMEOUT
        } else if mode == "tun" {
            TUN_READY_TIMEOUT
        } else {
            Duration::from_secs(9)
        };
    let mut check = config_command(true)
        .spawn()
        .map_err(|_| "无法启动内核检查")?;
    assign(&mut check, &job)?;
    use std::io::Write;
    if check
        .stdin
        .take()
        .ok_or("无法打开内核配置管道")?
        .write_all(&config)
        .is_err()
    {
        return Err("内核配置检查失败".into());
    }
    loop {
        if let Some(status) = check.try_wait().map_err(|_| "无法完成内核检查")? {
            if !status.success() {
                return Err("内核配置检查失败".into());
            }
            break;
        }
        if stop.signaled(50)
            || parent.signaled(0)
            || dependency.as_ref().is_some_and(|policy| policy.signaled(0))
            || Instant::now() >= deadline
        {
            let _ = check.kill();
            let _ = check.wait();
            return Err("内核配置检查已停止或超时".into());
        }
    }
    let mut child = config_command(false)
        .spawn()
        .map_err(|_| "无法启动代理内核")?;
    assign(&mut child, &job)?;
    child
        .stdin
        .take()
        .ok_or("无法打开内核配置管道")?
        .write_all(&config)
        .map_err(|_| "内核拒绝代理配置")?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    loop {
        if stop.signaled(0)
            || parent.signaled(0)
            || dependency.as_ref().is_some_and(|policy| policy.signaled(0))
            || child
                .try_wait()
                .map_err(|_| "无法读取内核进程状态")?
                .is_some()
            || Instant::now() >= deadline
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地代理入口未就绪".into());
        }
        let tun_ready =
            mode != "tun" || UdpSocket::bind((std::net::Ipv4Addr::new(172, 28, 254, 1), 0)).is_ok();
        let dns_ready = policy_dns.is_none_or(|dns| UdpSocket::bind(("127.0.0.1", dns)).is_err());
        if tun_ready
            && dns_ready
            && TcpStream::connect_timeout(&address, Duration::from_millis(80)).is_ok()
            && (core == Core::Bridge || controller.ready())
        {
            break;
        }
        thread::sleep(Duration::from_millis(70));
    }
    if core == Core::Mihomo && !selections.is_empty() {
        let budget = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(6));
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            runtime.block_on(mihomo::restore_selections(&controller, selections, budget));
        }
        if stop.signaled(0)
            || parent.signaled(0)
            || child.try_wait().map_err(|_| "无法读取内核状态")?.is_some()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Mihomo 在恢复策略选择时已停止".into());
        }
    }
    if mode == "system" {
        system_proxy::enable(&journal, port).map_err(|_| "无法设置系统代理")?;
    }
    unsafe {
        SetEvent(ready.0);
    }
    while !stop.signaled(150)
        && !parent.signaled(0)
        && dependency.as_ref().is_none_or(|policy| !policy.signaled(0))
        && matches!(child.try_wait(), Ok(None))
    {}
    let restored = if mode == "policy" {
        Ok(())
    } else {
        system_proxy::recover(&journal)
    };
    let _ = child.kill();
    let _ = child.wait();
    restored.map_err(|_| "无法恢复系统代理".into())
}

pub fn cli() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--network-worker") => Some(match run_worker(&args[1..]) {
            Ok(()) => 0,
            Err(reason) => {
                eprintln!("{reason}");
                1
            }
        }),
        Some("--recover-network") => Some(if recover().is_ok() { 0 } else { 1 }),
        _ => None,
    }
}

#[cfg(test)]
#[path = "network/mihomo_tun_test.rs"]
mod mihomo_tun_test;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_and_udp_bind_conflicts_are_detected_before_network_changes() {
        let tcp = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert!(ensure_port_available(tcp.local_addr().unwrap().port()).is_err());
        let udp = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        assert!(ensure_port_available(udp.local_addr().unwrap().port()).is_err());
    }
    #[test]
    fn elevated_worker_rejects_unexpected_fields() {
        let mut config = json!({
            "outbounds": [{"type":"vless","tag":"proxy","server":"example.com","server_port":443,"uuid":"00000000-0000-4000-8000-000000000000"},{"type":"direct","tag":"direct"}],
            "route": {"rules":[]}
        });
        let first = tun_interface("2c09680c214648ca8f08c155e93bc721");
        let second = tun_interface("e91fe4c94dd043bda858623f29ef8bbe");
        assert_ne!(first, second);
        let generated = tun_config(&config, 17771, &first).unwrap();
        assert_eq!(
            generated["inbounds"][1]["interface_name"].as_str(),
            Some(first.as_str())
        );
        config["outbounds"][0]["tls"] = json!({"enabled":true,"certificate_path":"sensitive"});
        assert!(tun_config(&config, 17771, &second).is_none());
    }

    #[test]
    fn routing_modes_preserve_dns_interception_and_user_rule_order() {
        let guarded = json!({"domain":["example.com"],"action":"reject"});
        let mut config = json!({"route":{"final":"proxy","rules":[
            {"action":"sniff"},{"protocol":"dns","action":"hijack-dns"},guarded
        ]}});
        add_routing_modes(&mut config, true).unwrap();
        assert_eq!(
            config["route"]["rules"],
            json!([
                {"action":"sniff"},{"protocol":"dns","action":"hijack-dns"},
                {"clash_mode":"direct","outbound":"direct"},
                {"clash_mode":"global","outbound":"proxy"},
                {"domain":["example.com"],"action":"reject"},
                {"clash_mode":"rule","outbound":"proxy"}
            ])
        );
    }

    #[test]
    fn elevated_rules_accept_only_present_outbounds_and_valid_networks() {
        let outbounds = vec![json!({"tag":"direct"}), json!({"tag":"node-1"})];
        let rule = json!({"ip_cidr":["2001:db8::/32","192.0.2.0/24"],"outbound":"node-1"});
        assert!(validate_rule(&rule, &outbounds, &[]).is_some());
        assert!(validate_rule(
            &json!({"ip_cidr":["2001:db8::/129"],"outbound":"node-1"}),
            &outbounds,
            &[]
        )
        .is_none());
        assert!(validate_rule(
            &json!({"domain":["example.org"],"outbound":"absent"}),
            &outbounds,
            &[]
        )
        .is_none());
        assert!(validate_rule(
            &json!({"ip_cidr":["127.0.0.1/32"],"domain":["example.org"],"action":"reject"}),
            &outbounds,
            &[]
        )
        .is_none());
    }

    #[test]
    fn wireguard_is_an_unprivileged_endpoint_inside_tun_configuration() {
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let mut config = json!({
            "outbounds":[{
                "type":"selector","tag":"proxy","outbounds":["node-0"],"default":"node-0",
                "interrupt_exist_connections":false
            },{"type":"direct","tag":"wireguard-uplink","connect_timeout":"5s"},{"type":"direct","tag":"direct"}],
            "endpoints":[{
                "type":"wireguard","system":false,"tag":"node-0","detour":"wireguard-uplink",
                "private_key":key,"address":["192.0.2.7/32"],
                "peers":[{"address":"example.org","port":51820,"public_key":key,"allowed_ips":["0.0.0.0/0"]}]
            }],
            "route":{"rules":[{"inbound":["node-0"],"action":"reject"},{"domain":["example.org"],"outbound":"node-0"}]}
        });
        let mut trusted = tun_config(&config, 17771, "Fixture").unwrap();
        add_routing_modes(&mut trusted, true).unwrap();
        assert_eq!(
            trusted["route"]["rules"][0],
            json!({"inbound":["node-0"],"action":"reject"})
        );
        assert_eq!(trusted["route"]["rules"][3]["clash_mode"], "direct");
        config["route"]["rules"][0]["action"] = json!("route");
        assert!(tun_config(&config, 17771, "Fixture").is_none());
        config["route"]["rules"][0]["action"] = json!("reject");
        config["endpoints"][0]["detour"] = json!("proxy");
        assert!(tun_config(&config, 17771, "Fixture").is_none());
        config["endpoints"][0]["detour"] = json!("wireguard-uplink");
        config["endpoints"][0]["system"] = json!(true);
        assert!(tun_config(&config, 17771, "Fixture").is_none());
    }
}
