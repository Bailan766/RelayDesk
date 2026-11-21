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
    process::{Child, Command, Stdio},
};
use winapi::{
    shared::{
        ifdef::NET_LUID,
        minwindef::{FALSE, TRUE},
        netioapi::{
            ConvertInterfaceAliasToLuid, ConvertInterfaceLuidToIndex, CreateIpForwardEntry2,
            FreeMibTable, GetIpForwardEntry2, GetIpForwardTable2, MIB_IPFORWARD_ROW2,
        },
        winerror::{ERROR_NOT_FOUND, ERROR_OBJECT_ALREADY_EXISTS},
        ws2def::{AF_INET, AF_INET6},
    },
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

use tun_control::TunControl;

#[path = "network/tun_control.rs"]
mod tun_control;

const APPLY_TIMEOUT: Duration = Duration::from_secs(15);
const TUN_READY_TIMEOUT: Duration = Duration::from_secs(20);
const MIHOMO_READY_TIMEOUT: Duration = Duration::from_secs(40);
const MIHOMO_RESTART_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TUN_ROUTE_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const TUN_ROUTE_RECOVERY_ATTEMPTS: u8 = 12;

#[derive(Clone, Copy, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Core {
    #[default]
    Singbox,
    Mihomo,
    Bridge,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SessionOptions {
    #[serde(default)]
    pub allow_lan: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypass: Option<String>,
    #[serde(default = "default_true")]
    pub tun_ipv6: bool,
}

fn default_true() -> bool {
    true
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            allow_lan: false,
            bypass: None,
            tun_ipv6: true,
        }
    }
}

#[repr(C)]
struct TokenElevation {
    token_is_elevated: u32,
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(
        process_handle: HANDLE,
        desired_access: u32,
        token_handle: *mut HANDLE,
    ) -> i32;
    fn GetTokenInformation(
        token_handle: HANDLE,
        token_information_class: u32,
        token_information: *mut std::ffi::c_void,
        token_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

pub fn is_elevated() -> bool {
    use winapi::um::{processthreadsapi::GetCurrentProcess, winnt::TOKEN_QUERY};
    const TOKEN_ELEVATION_CLASS: u32 = 20;
    let mut token: HANDLE = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let Ok(token) = Handle::new(token) else {
        return false;
    };
    let mut elevation = TokenElevation {
        token_is_elevated: 0,
    };
    let mut size = 0u32;
    unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_ELEVATION_CLASS,
            (&mut elevation as *mut TokenElevation).cast(),
            std::mem::size_of::<TokenElevation>() as u32,
            &mut size,
        ) != 0
            && elevation.token_is_elevated != 0
    }
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

fn interface_index(alias: &str) -> Option<u32> {
    let name = wide(alias);
    let mut luid = NET_LUID { Value: 0 };
    let mut index = 0;
    unsafe {
        if ConvertInterfaceAliasToLuid(name.as_ptr(), &mut luid) == 0
            && ConvertInterfaceLuidToIndex(&luid, &mut index) == 0
        {
            Some(index)
        } else {
            None
        }
    }
}

fn tun_default_route(alias: &str, family: u16) -> Option<MIB_IPFORWARD_ROW2> {
    let index = interface_index(alias)?;
    let mut table = ptr::null_mut();
    unsafe {
        if GetIpForwardTable2(family, &mut table) != 0 || table.is_null() {
            return None;
        }
        // Windows allocates NumEntries rows after the header, including SDK alignment padding.
        let rows = std::slice::from_raw_parts(
            ptr::addr_of!((*table).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*table).NumEntries as usize,
        );
        let route = rows
            .iter()
            .find(|row| row.InterfaceIndex == index && row.DestinationPrefix.PrefixLength == 0)
            .copied();
        FreeMibTable(table.cast());
        route
    }
}

fn restore_tun_default_route(alias: &str, family: u16, saved: &MIB_IPFORWARD_ROW2) -> bool {
    let mut current = *saved;
    match unsafe { GetIpForwardEntry2(&mut current) } {
        0 => true,
        ERROR_NOT_FOUND if interface_index(alias) == Some(saved.InterfaceIndex) => {
            // A replacement default route on the same interface is already sufficient.
            tun_default_route(alias, family).is_some()
                || matches!(
                    unsafe { CreateIpForwardEntry2(saved) },
                    0 | ERROR_OBJECT_ALREADY_EXISTS
                )
        }
        _ => false,
    }
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

const TUN_RETRY_DELAYS_MS: [u32; 3] = [1500, 4000, 10000];
const TUN_STABLE_TIME: Duration = Duration::from_secs(45);

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
        if self.0.is_null() {
            return false;
        }
        unsafe { WaitForSingleObject(self.0, timeout) == WAIT_OBJECT_0 }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
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
            "find_process",
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
    let mut direct_domains = Vec::new();
    let mut direct_suffixes = Vec::new();
    for rule in rules {
        validate_rule(rule, outbounds, endpoints)?;
        if rule.get("outbound").and_then(Value::as_str) == Some("direct") {
            if let Some(items) = rule.get("domain").and_then(Value::as_array) {
                direct_domains.extend(items.iter().filter_map(Value::as_str).map(|s| json!(s)));
            }
            if let Some(items) = rule.get("domain_suffix").and_then(Value::as_array) {
                direct_suffixes.extend(items.iter().filter_map(Value::as_str).map(|s| json!(s)));
            }
        }
        output_rules.push(rule.clone());
    }
    let route_final = match route.get("final").and_then(Value::as_str) {
        Some("direct") => "direct",
        _ => "proxy",
    };
    let mut dns_rules = vec![json!({"clash_mode":"direct","action":"route","server":"bootstrap"})];
    if !direct_domains.is_empty() {
        dns_rules.push(json!({"domain": direct_domains, "action": "route", "server": "bootstrap"}));
    }
    if !direct_suffixes.is_empty() {
        dns_rules.push(json!({"domain_suffix": direct_suffixes, "action": "route", "server": "bootstrap"}));
    }
    dns_rules.push(json!({"inbound":["tun","local"],"action":"route","server":"remote"}));
    Some(json!({
        "log": {"level":"warn"},
        "inbounds": [
            {"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port},
            {"type":"tun","tag":"tun","interface_name":interface_name,"address":["172.28.254.1/30","fdfe:dcba:9876::1/126"],"auto_route":true,"strict_route":true,"stack":"mixed"}
        ],
        "outbounds": outbounds,
        "endpoints": endpoints,
        "route":{"rules":output_rules,"final":route_final,"auto_detect_interface":true,"find_process":true,"default_domain_resolver":"bootstrap"},
        "dns":{
            "servers":[{"type":"local","tag":"bootstrap"},{"type":"https","tag":"remote","server":"1.1.1.1","path":"/dns-query","detour":"proxy"}],
            "rules": dns_rules,
            "final":"bootstrap"
        }
    }))
}

pub struct Session {
    worker: Handle,
    stop: Handle,
    pub port: u16,
    pub controller: crate::telemetry::Controller,
    pub id: String,
    pub tun_dns: Option<(u16, u16)>,
    pub allow_lan: bool,
    policy: Option<Box<Session>>,
    tun_control: Option<TunControl>,
    staged_policy_recovery: Option<u32>,
    service: Option<crate::service::ServiceSession>,
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
    #[serde(default)]
    options: SessionOptions,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureTarget {
    mixed_port: u16,
    dns_port: u16,
    system_dns: u16,
    policy_pid: u32,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct PolicyRestart {
    config: Value,
    selections: BTreeMap<String, String>,
}

fn request_policy_restart(home: &std::path::Path, restart: &PolicyRestart) -> Result<(), String> {
    let data = serde_json::to_vec(restart).map_err(|_| "无法保存 Mihomo 恢复状态")?;
    let protected = crate::storage::transform(&data, true)?;
    let temporary = home.join(format!("restart-{}.tmp", uuid::Uuid::new_v4().simple()));
    let _cleanup = crate::TemporaryConfig(temporary.clone());
    fs::write(&temporary, protected).map_err(|_| "无法保存 Mihomo 恢复状态")?;
    fs::rename(&temporary, home.join("restart.bin")).map_err(|_| "无法提交 Mihomo 恢复状态".into())
}

fn receive_policy_restart(
    home: &std::path::Path,
    lifetime: &WorkerLifetime<'_>,
    control: &TunControl,
) -> Result<Option<PolicyRestart>, String> {
    let path = home.join("restart.bin");
    let _cleanup = crate::TemporaryConfig(path.clone());
    let deadline = Instant::now() + MIHOMO_RESTART_REQUEST_TIMEOUT;
    while control.enabled() && !lifetime.ended(60) && Instant::now() < deadline {
        match fs::read(&path) {
            Ok(protected) => {
                let data = crate::storage::transform(&protected, false)?;
                return serde_json::from_slice(&data)
                    .map(Some)
                    .map_err(|_| "Mihomo 恢复状态无效".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法读取 Mihomo 恢复状态".into()),
        }
    }
    Ok(None)
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
            {"type":"direct","tag":"system-dns-in","listen":"127.0.0.1","listen_port":target.system_dns},
            {"type":"tun","tag":"tun","interface_name":interface,"address":["172.28.254.1/30","fdfe:dcba:9876::1/126"],
             "auto_route":true,"strict_route":true,"stack":"mixed"}
        ],
        "outbounds":[
            {"type":"socks","tag":"policy","server":"127.0.0.1","server_port":target.mixed_port,"version":"5"},
            {"type":"direct","tag":"physical"}
        ],
        "route":{"auto_detect_interface":true,"default_domain_resolver":"system-dns","final":"policy","rules":[
            {"inbound":"system-dns-in","action":"hijack-dns"},
            {"process_path_regex":[expression],"outbound":"physical"},
            {"action":"sniff"},
            {"protocol":"dns","action":"hijack-dns"}
        ]},
        "dns":{"servers":[
            {"type":"udp","tag":"policy-dns","server":"127.0.0.1","server_port":target.dns_port},
            {"type":"local","tag":"system-dns","prefer_go":true}
        ],"rules":[
            {"inbound":"system-dns-in","action":"route","server":"system-dns"},
            {"inbound":"tun","action":"route","server":"policy-dns","disable_cache":true}
        ],"final":"policy-dns"}
    })
}

const MIHOMO_GEODATA_FILES: &[&str] = &[
    "Country.mmdb",
    "geoip.metadb",
    "geoip.dat",
    "geosite.dat",
    "ASN.mmdb",
];

fn mihomo_cache_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(env::var_os("LOCALAPPDATA")?)
        .join("RelayDesk")
        .join("mihomo-cache");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn seed_mihomo_geodata(home: &std::path::Path) {
    let cache = mihomo_cache_dir();
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf));
    for name in MIHOMO_GEODATA_FILES {
        let dst = home.join(name);
        if dst.exists() {
            continue;
        }
        if let Some(src) = cache
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|path| path.is_file())
        {
            let _ = fs::copy(src, &dst);
            continue;
        }
        if let Some(src) = exe_dir
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|path| path.is_file())
        {
            let _ = fs::copy(src, &dst);
        }
    }
}

fn save_mihomo_geodata(home: &std::path::Path) {
    let Some(cache) = mihomo_cache_dir() else {
        return;
    };
    for name in MIHOMO_GEODATA_FILES {
        let src = home.join(name);
        let dst = cache.join(name);
        if let Ok(meta) = fs::metadata(&src) {
            if meta.is_file() && meta.len() > 0 {
                let _ = fs::copy(&src, &dst);
            }
        }
    }
}

struct MihomoHome(PathBuf);
impl Drop for MihomoHome {
    fn drop(&mut self) {
        save_mihomo_geodata(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Session {
    pub fn start(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        recover: bool,
    ) -> Result<Self, String> {
        Self::start_with_options(
            settings,
            port,
            mode,
            routing_mode,
            recover,
            SessionOptions::default(),
        )
    }

    pub fn start_with_options(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        recover: bool,
        options: SessionOptions,
    ) -> Result<Self, String> {
        if mode == "tun" {
            if let Some(result) =
                crate::service::try_start_tun(&settings, port, routing_mode, recover, &options)
            {
                let service = result?;
                return Ok(Self {
                    worker: Handle(ptr::null_mut()),
                    stop: Handle(ptr::null_mut()),
                    port: service.port,
                    controller: service.controller.clone(),
                    id: service.id.clone(),
                    tun_dns: service.tun_dns,
                    allow_lan: service.allow_lan,
                    policy: None,
                    tun_control: None,
                    staged_policy_recovery: None,
                    service: Some(service),
                });
            }
        }
        let executable = env::current_exe().map_err(|_| "无法定位当前应用")?;
        Self::start_using_with_options(
            settings,
            port,
            mode,
            routing_mode,
            &executable,
            recover,
            options,
        )
    }

    pub(crate) fn start_using(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        executable: &std::path::Path,
        recover: bool,
    ) -> Result<Self, String> {
        Self::start_using_with_options(
            settings,
            port,
            mode,
            routing_mode,
            executable,
            recover,
            SessionOptions::default(),
        )
    }

    pub(crate) fn start_using_with_options(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        executable: &std::path::Path,
        recover: bool,
        options: SessionOptions,
    ) -> Result<Self, String> {
        if !matches!(mode, "local" | "system" | "tun") {
            return Err("代理入口模式无效".into());
        }
        if settings.core == Core::Mihomo && mode == "tun" {
            let dns_port = auxiliary_port(&[port])?;
            let system_dns = auxiliary_port(&[port, dns_port])?;
            let local_port = auxiliary_port(&[port, dns_port, system_dns])?;
            let initial = mihomo::prepare_tun_policy_with_lan(
                &settings.config,
                port,
                routing_mode,
                dns_port,
                None,
                options.allow_lan,
            )?;
            let attached = mihomo::prepare_tun_policy_with_lan(
                &settings.config,
                port,
                routing_mode,
                dns_port,
                Some(system_dns),
                options.allow_lan,
            )?;
            let selections = settings.selections.clone();
            let policy = Self::start_worker(
                settings,
                port,
                "policy",
                routing_mode,
                executable,
                Some(dns_port),
                recover,
                options.clone(),
            )?;
            let policy_pid = unsafe { GetProcessId(policy.worker.0) };
            if policy_pid == 0 {
                return Err("无法监视 Mihomo 网络进程".into());
            }
            let target = CaptureTarget {
                mixed_port: port,
                dns_port,
                system_dns,
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
                recover,
                options.clone(),
            )?;
            capture.port = port;
            capture.controller = policy.controller.clone();
            capture.tun_dns = Some((dns_port, system_dns));
            capture.allow_lan = options.allow_lan;
            capture.policy = Some(Box::new(policy));
            // Provider startup uses the ordinary system resolver until the TUN is attached.
            if initial != attached {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| "无法配置 TUN 的系统 DNS")?;
                runtime.block_on(async {
                    if !capture.controller.reload_mihomo(attached).await? {
                        return Err("Mihomo 未启用 TUN 的系统 DNS".to_string());
                    }
                    mihomo::restore_selections(
                        &capture.controller,
                        selections,
                        Duration::from_secs(6),
                    )
                    .await;
                    Ok(())
                })?;
            }
            return Ok(capture);
        }
        if settings.core == Core::Mihomo {
            mihomo::prepare_with_lan(&settings.config, port, routing_mode, options.allow_lan)?;
        }
        Self::start_worker(
            settings,
            port,
            mode,
            routing_mode,
            executable,
            None,
            recover,
            options,
        )
    }

    fn start_worker(
        settings: CoreSettings,
        port: u16,
        mode: &str,
        routing_mode: RoutingMode,
        executable: &std::path::Path,
        policy_dns: Option<u16>,
        recover: bool,
        options: SessionOptions,
    ) -> Result<Self, String> {
        let core = settings.core;
        ensure_port_available(port)?;
        let directory = runtime_dir()?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let tun_control = if matches!(mode, "tun" | "policy") {
            Some(TunControl::create(
                &token,
                recover,
                routing_mode,
                &settings.config,
            )?)
        } else {
            None
        };
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
        let allow_lan = options.allow_lan;
        let input = WorkerInput {
            settings,
            controller: controller.clone(),
            routing_mode,
            policy_dns,
            options,
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
        let verb = wide(if mode == "tun" && !is_elevated() {
            "runas"
        } else {
            "open"
        });
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
            tun_dns: None,
            allow_lan,
            policy: None,
            tun_control,
            staged_policy_recovery: None,
            service: None,
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

    pub fn using_service(&self) -> bool {
        self.service.is_some()
    }

    pub fn running(&self) -> bool {
        if let Some(svc) = &self.service {
            return svc.state.running.load(std::sync::atomic::Ordering::Acquire);
        }
        !self.worker.signaled(0) && self.policy.as_ref().is_none_or(|policy| policy.running())
    }

    pub fn recovering_tun(&self) -> bool {
        if let Some(svc) = &self.service {
            return svc
                .state
                .recovering
                .load(std::sync::atomic::Ordering::Acquire);
        }
        self.tun_control
            .as_ref()
            .is_some_and(TunControl::recovering)
            || self
                .policy
                .as_ref()
                .is_some_and(|policy| policy.recovering_tun())
    }

    pub fn ready(&self) -> bool {
        self.running() && !self.recovering_tun()
    }

    pub fn generation(&self) -> u32 {
        if let Some(svc) = &self.service {
            return svc
                .state
                .generation
                .load(std::sync::atomic::Ordering::Acquire);
        }
        self.tun_control
            .as_ref()
            .map_or(0, TunControl::generation)
            .wrapping_add(self.policy.as_ref().map_or(0, |policy| policy.generation()))
    }

    pub fn configure_tun_recovery(&self, enabled: bool) {
        if let Some(svc) = &self.service {
            let _ = svc.send_command(&crate::service::PipeCommand::SetRecovery { enabled });
            return;
        }
        if let Some(control) = &self.tun_control {
            control.set_recovery(enabled);
        }
        if let Some(policy) = &self.policy {
            policy.configure_tun_recovery(enabled);
        }
    }

    pub fn needs_policy_restart(&self) -> bool {
        if self.service.is_some() {
            return false;
        }
        self.policy
            .as_ref()
            .and_then(|policy| policy.tun_control.as_ref())
            .is_some_and(|control| {
                control.enabled()
                    && control.recovering()
                    && self.staged_policy_recovery != Some(control.generation())
            })
    }

    pub fn stage_policy_restart(
        &mut self,
        settings: &CoreSettings,
        mode: RoutingMode,
    ) -> Result<(), String> {
        if self.service.is_some() {
            return Ok(());
        }
        let Some((policy, (dns, system_dns))) = self.policy.as_ref().zip(self.tun_dns) else {
            return Ok(());
        };
        if !self.needs_policy_restart() {
            return Ok(());
        }
        let generation = policy.generation();
        let request = PolicyRestart {
            config: mihomo::prepare_tun_policy_with_lan(
                &settings.config,
                self.port,
                mode,
                dns,
                Some(system_dns),
                self.allow_lan,
            )?,
            selections: settings.selections.clone(),
        };
        let home = runtime_dir()?.join(format!("mihomo-{}", policy.id));
        request_policy_restart(&home, &request)?;
        self.staged_policy_recovery = Some(generation);
        Ok(())
    }

    pub fn remember_tun_route(&self, mode: RoutingMode, config: &Value) {
        if let Some(svc) = &self.service {
            let _ = svc.send_command(&crate::service::PipeCommand::SyncRouting {
                routing_mode: mode,
                config: config.clone(),
            });
            return;
        }
        if let Some(control) = &self.tun_control {
            control.set_routing(mode, config);
        }
    }

    pub fn sync_mihomo_config(&self, config: &Value, selections: &BTreeMap<String, String>) {
        if let Some(svc) = &self.service {
            let _ = svc.send_command(&crate::service::PipeCommand::SyncMihomo {
                config: config.clone(),
                selections: selections.clone(),
            });
        }
    }

    #[cfg(test)]
    pub fn kill_fixture_worker(&self) {
        use winapi::um::processthreadsapi::TerminateProcess;
        assert_ne!(unsafe { TerminateProcess(self.worker.0, 1) }, 0);
        assert!(self.worker.signaled(5000));
    }

    pub fn stop(mut self) -> Result<(), String> {
        if let Some(svc) = self.service.take() {
            return svc.stop();
        }
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
        if !self.stop.0.is_null() {
            unsafe {
                SetEvent(self.stop.0);
            }
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

struct WorkerLifetime<'a> {
    stop: &'a Handle,
    parent: &'a Handle,
    policy: Option<&'a Handle>,
}

impl WorkerLifetime<'_> {
    fn ended(&self, wait: u32) -> bool {
        self.stop.signaled(wait)
            || self.parent.signaled(0)
            || self.policy.is_some_and(|policy| policy.signaled(0))
    }
}

fn stop_core(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn attach_stderr_logger(child: &mut Child, label: &'static str) -> Option<std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>> {
    use std::io::{BufRead, BufReader};
    let stderr = child.stderr.take()?;
    let tail = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::with_capacity(12)));
    let sink = std::sync::Arc::clone(&tail);
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let clean = crate::telemetry::redact_log_payload(&line);
            if clean.is_empty() {
                continue;
            }
            crate::logs::append(label, "error", &clean);
            if let Ok(mut lines) = sink.lock() {
                if lines.len() >= 12 {
                    lines.pop_front();
                }
                lines.push_back(clean);
            }
        }
    });
    Some(tail)
}

fn start_core(command: &mut Command, job: &Handle, config: &[u8]) -> Result<Child, String> {
    use std::io::Write;
    let mut child = command.spawn().map_err(|_| "无法启动代理内核")?;
    assign(&mut child, job)?;
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(config).is_ok());
    if !written {
        stop_core(&mut child);
        return Err("内核拒绝代理配置".into());
    }
    Ok(child)
}

fn await_core(
    child: &mut Child,
    lifetime: &WorkerLifetime<'_>,
    deadline: Instant,
    recovery: Option<&TunControl>,
    mut is_ready: impl FnMut() -> bool,
) -> Result<(), String> {
    loop {
        if lifetime.ended(0)
            || recovery.is_some_and(|control| !control.enabled())
            || !matches!(child.try_wait(), Ok(None))
            || Instant::now() >= deadline
        {
            stop_core(child);
            return Err("本地代理入口未就绪".into());
        }
        if is_ready() {
            return Ok(());
        }
        if lifetime.ended(70) {
            stop_core(child);
            return Err("本地代理入口已停止".into());
        }
    }
}

fn wait_tun_retry(lifetime: &WorkerLifetime<'_>, control: &TunControl, delay: u32) -> bool {
    let deadline = Instant::now() + Duration::from_millis(u64::from(delay));
    while control.enabled() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return !lifetime.ended(0);
        }
        if lifetime.ended(remaining.as_millis().clamp(1, 150) as u32) {
            return false;
        }
    }
    false
}

fn supervise_core(
    child: &mut Child,
    lifetime: &WorkerLifetime<'_>,
    interface: &str,
    tun_route: Option<MIB_IPFORWARD_ROW2>,
) -> bool {
    let ipv4_route = tun_route;
    let ipv6_route = tun_route.and_then(|_| tun_default_route(interface, AF_INET6 as u16));
    let mut next_route_check = ipv4_route.map(|_| Instant::now() + TUN_ROUTE_CHECK_INTERVAL);
    let mut failed_route_checks = 0;
    while !lifetime.ended(150) {
        if let Ok(Some(status)) = child.try_wait() {
            crate::logs::append(
                "worker",
                "warn",
                &format!("代理内核进程提前退出（状态码：{:?}）", status.code()),
            );
            return true;
        }
        let now = Instant::now();
        if next_route_check.is_some_and(|check| now >= check) {
            next_route_check = Some(now + TUN_ROUTE_CHECK_INTERVAL);
            let v4_ready = ipv4_route
                .is_none_or(|saved| restore_tun_default_route(interface, AF_INET as u16, &saved));
            if let Some(saved_v6) = ipv6_route {
                let _ = restore_tun_default_route(interface, AF_INET6 as u16, &saved_v6);
            }
            if v4_ready {
                failed_route_checks = 0;
            } else {
                failed_route_checks += 1;
                if failed_route_checks >= TUN_ROUTE_RECOVERY_ATTEMPTS {
                    crate::logs::append(
                        "worker",
                        "warn",
                        "TUN IPv4 默认路由持续缺失 12 秒，触发内核重连恢复",
                    );
                    return true;
                }
            }
        }
    }
    false
}

fn restore_policy_choices(
    controller: &crate::telemetry::Controller,
    selections: &BTreeMap<String, String>,
    deadline: Instant,
) {
    if selections.is_empty() {
        return;
    }
    let budget = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(6));
    if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        runtime.block_on(mihomo::restore_selections(
            controller,
            selections.clone(),
            budget,
        ));
    }
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
        options,
    } = serde_json::from_slice(&config).map_err(|_| "内核配置无效")?;
    let allow_lan = options.allow_lan;
    let tun_ipv6 = options.tun_ipv6;
    let bypass = options.bypass;
    if (mode == "policy" && (core != Core::Mihomo || policy_dns.is_none()))
        || (mode != "policy" && policy_dns.is_some())
        || (core == Core::Bridge && mode != "tun")
    {
        return Err("TUN 转发参数不符合入口类型".into());
    }
    let mut interface = tun_interface(token);
    let control = if matches!(mode.as_str(), "tun" | "policy") {
        TunControl::open(token).ok()
    } else {
        None
    };
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
            mihomo::prepare_tun_policy_with_lan(&config, port, routing_mode, dns, None, allow_lan)?
        } else {
            mihomo::prepare_with_lan(&config, port, routing_mode, allow_lan)?
        };
        controller.configure_mihomo(&mut config);
        let path = directory.join(format!("mihomo-{token}"));
        fs::create_dir(&path).map_err(|_| "无法创建 Mihomo 工作目录")?;
        seed_mihomo_geodata(&path);
        Some(MihomoHome(path))
    } else if core == Core::Bridge {
        let target: CaptureTarget =
            serde_json::from_value(config).map_err(|_| "TUN 转发目标无效")?;
        let ports = [target.mixed_port, target.dns_port, target.system_dns];
        if ports.iter().any(|entry| *entry < 1024 || *entry == port)
            || target.mixed_port == target.dns_port
            || [target.mixed_port, target.dns_port].contains(&target.system_dns)
            || target.policy_pid == 0
            || target.policy_pid == std::process::id()
            || target.policy_pid == parent_id
        {
            return Err("TUN 转发端口或进程无效".into());
        }
        dependency = Some(Handle::new(unsafe {
            OpenProcess(SYNCHRONIZE, FALSE, target.policy_pid)
        })?);
        ensure_port_available(target.system_dns)?;
        let program = crate::bundled_binary("mihomo.exe")?;
        config = capture_config(&target, port, &interface, &program);
        if !tun_ipv6 {
            config["inbounds"][1]["address"] = json!(["172.28.254.1/30"]);
        }
        if allow_lan {
            config["inbounds"][0]["listen"] = json!("0.0.0.0");
        }
        None
    } else {
        if mode == "tun" {
            config = tun_config(&config, port, &interface).ok_or("TUN 配置无效")?;
            if !tun_ipv6 {
                config["inbounds"][1]["address"] = json!(["172.28.254.1/30"]);
            }
        }
        if allow_lan {
            config["inbounds"][0]["listen"] = json!("0.0.0.0");
        }
        add_routing_modes(&mut config, mode == "tun").ok_or("无法配置路由模式")?;
        controller.configure(&mut config, routing_mode.name());
        None
    };
    let binary = match core {
        Core::Singbox | Core::Bridge => core_path()?,
        Core::Mihomo => crate::bundled_binary("mihomo.exe")?,
    };
    let initial = serde_json::to_vec(&config).map_err(|_| "内核配置无效")?;
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
            .stderr(Stdio::piped());
        command
    };
    let timeout = if core == Core::Mihomo {
        MIHOMO_READY_TIMEOUT
    } else if mode == "tun" {
        TUN_READY_TIMEOUT
    } else {
        Duration::from_secs(9)
    };
    let lifetime = WorkerLifetime {
        stop: &stop,
        parent: &parent,
        policy: dependency.as_ref(),
    };
    let initial_deadline = Instant::now() + timeout;
    let mut check = start_core(&mut config_command(true), &job, &initial)?;
    let check_stderr = attach_stderr_logger(&mut check, "core-check");
    loop {
        if let Some(status) = check.try_wait().map_err(|_| "无法完成内核检查")? {
            if !status.success() {
                let detail = check_stderr
                    .as_ref()
                    .and_then(|lines| lines.lock().ok()?.back().cloned());
                return Err(match detail {
                    Some(msg) => format!("内核配置检查失败：{msg}"),
                    None => "内核配置检查失败".into(),
                });
            }
            break;
        }
        if lifetime.ended(50) || Instant::now() >= initial_deadline {
            stop_core(&mut check);
            return Err("内核配置检查已停止或超时".into());
        }
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let launch = |config: &[u8], deadline, interface: &str, recovery: Option<&TunControl>| {
        let mut child = start_core(&mut config_command(false), &job, config)?;
        let core_stderr = attach_stderr_logger(&mut child, "core");
        let mut route = None;
        let mut ipv4_ready_at: Option<Instant> = None;
        if let Err(err) = await_core(&mut child, &lifetime, deadline, recovery, || {
            if mode == "tun" {
                if UdpSocket::bind((std::net::Ipv4Addr::new(172, 28, 254, 1), 0)).is_err() {
                    return false;
                }
                route = tun_default_route(interface, AF_INET as u16);
                if route.is_none() {
                    ipv4_ready_at = None;
                    return false;
                }
                if tun_ipv6 && tun_default_route(interface, AF_INET6 as u16).is_none() {
                    let since = *ipv4_ready_at.get_or_insert_with(Instant::now);
                    if since.elapsed() < Duration::from_millis(800) {
                        return false;
                    }
                }
            }
            policy_dns.is_none_or(|dns| UdpSocket::bind(("127.0.0.1", dns)).is_err())
                && TcpStream::connect_timeout(&address, Duration::from_millis(80)).is_ok()
                && (core == Core::Bridge || controller.ready())
        }) {
            let detail = core_stderr
                .as_ref()
                .and_then(|lines| lines.lock().ok()?.back().cloned());
            return Err(match detail {
                Some(msg) => format!("{err}：{msg}"),
                None => err,
            });
        }
        Ok::<_, String>((child, route))
    };
    let (mut child, mut route) = launch(&initial, initial_deadline, &interface, None)?;
    if core == Core::Mihomo {
        restore_policy_choices(&controller, &selections, initial_deadline);
        if lifetime.ended(0) || !matches!(child.try_wait(), Ok(None)) {
            stop_core(&mut child);
            return Err("Mihomo 在恢复策略选择时已停止".into());
        }
    }
    if mode == "system" {
        let bypass_text = bypass
            .as_deref()
            .unwrap_or("localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;[::1];<local>");
        system_proxy::enable_with_bypass(&journal, port, bypass_text)
            .map_err(|_| "无法设置系统代理")?;
    }
    unsafe {
        SetEvent(ready.0);
    }
    let mut retries = 0;
    let mut started = Instant::now();
    let mut failed = false;
    'session: loop {
        let lost = supervise_core(&mut child, &lifetime, &interface, route);
        if lost {
            if let Some(control) = &control {
                control.begin_recovery();
            }
        }
        stop_core(&mut child);
        if !lost || lifetime.ended(0) {
            break;
        }
        failed = matches!(mode.as_str(), "tun" | "policy");
        let Some(control) = &control else {
            break;
        };
        if started.elapsed() >= TUN_STABLE_TIME {
            retries = 0;
        }
        let policy_restart = if mode == "policy" && retries < TUN_RETRY_DELAYS_MS.len() {
            let home = home.as_ref().ok_or("Mihomo 恢复目录不可用")?;
            let Some(mut restart) = receive_policy_restart(&home.0, &lifetime, control)? else {
                break;
            };
            controller.configure_mihomo(&mut restart.config);
            Some(restart)
        } else {
            None
        };
        while let Some(delay) = TUN_RETRY_DELAYS_MS.get(retries) {
            if !wait_tun_retry(&lifetime, control, *delay) {
                break 'session;
            }
            retries += 1;
            let replacement = if let Some(policy) = &policy_restart {
                &policy.config
            } else {
                interface = tun_interface(&uuid::Uuid::new_v4().simple().to_string());
                let tun = config["inbounds"]
                    .as_array_mut()
                    .and_then(|inbounds| inbounds.iter_mut().find(|entry| entry["type"] == "tun"))
                    .ok_or("恢复 TUN 时找不到网卡设置")?;
                tun["interface_name"] = json!(&interface);
                if core == Core::Singbox {
                    control.restore_routing(&mut config);
                }
                &config
            };
            let replacement = serde_json::to_vec(replacement).map_err(|_| "恢复 TUN 配置失败")?;
            let deadline = Instant::now() + timeout;
            if let Ok((mut next, replacement_route)) =
                launch(&replacement, deadline, &interface, Some(control))
            {
                if let Some(policy) = &policy_restart {
                    restore_policy_choices(&controller, &policy.selections, deadline);
                    if !matches!(next.try_wait(), Ok(None)) {
                        stop_core(&mut next);
                        continue;
                    }
                }
                if !control.enabled() || lifetime.ended(0) {
                    stop_core(&mut next);
                    break 'session;
                }
                child = next;
                route = replacement_route;
                started = Instant::now();
                control.finish_recovery();
                failed = false;
                continue 'session;
            }
        }
        break;
    }
    let restored = if mode == "policy" {
        Ok(())
    } else {
        system_proxy::recover(&journal)
    };
    restored.map_err(|_| "无法恢复系统代理")?;
    if failed && !lifetime.ended(0) {
        return Err("TUN 会话中断".into());
    }
    Ok(())
}

pub fn cli() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--network-worker") => Some(match run_worker(&args[1..]) {
            Ok(()) => 0,
            Err(reason) => {
                crate::logs::append("worker", "error", &reason);
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
