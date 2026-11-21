#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Emitter, Manager};
mod failover;
mod hotkeys;
mod logs;
mod mihomo;
mod network;
mod netwatch;
mod probes;
mod service;
mod storage;
mod supervisor;
mod system_proxy;
mod telemetry;

fn core_command(path: &std::path::Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

type ProxyState = supervisor::Supervisor;

struct TemporaryConfig(PathBuf);
impl Drop for TemporaryConfig {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
#[tauri::command]
async fn local_tcp_google() -> Result<u64, String> {
    let started = std::time::Instant::now();
    tokio::time::timeout(
        Duration::from_secs(8),
        tokio::net::TcpStream::connect(("www.google.com", 443)),
    )
    .await
    .map_err(|_| "本地 TCP 连接超时")?
    .map_err(|_| "本地 DNS 解析或 TCP 连接失败")?;
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
async fn check_exit_ip(port: u16, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    Ok(check_exit_ip_detail(port, state).await?.ip)
}

#[tauri::command]
async fn check_exit_ip_detail(
    port: u16,
    state: tauri::State<'_, ProxyState>,
) -> Result<probes::ExitIpDetail, String> {
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
    probes::check_exit_ip_detail(port).await
}

#[tauri::command]
async fn check_unlock_service(
    service: String,
    port: u16,
    state: tauri::State<'_, ProxyState>,
) -> Result<probes::UnlockResult, String> {
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
    probes::check_unlock_service(&service, port).await
}

fn core_path() -> Result<PathBuf, String> {
    bundled_binary("sing-box.exe")
}

fn bundled_binary(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位应用目录")?;
    let core = exe.parent().ok_or("无法定位应用目录")?.join(name);
    if !core.is_file() {
        return Err(format!("应用目录缺少 {name}"));
    }
    Ok(core)
}

#[tauri::command]
fn allocate_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|_| "无法分配本地端口".into())
}

#[tauri::command]
fn allocate_stable_port() -> Result<u16, String> {
    for candidate in 17890u16..=17899 {
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok()
            && std::net::UdpSocket::bind(("127.0.0.1", candidate)).is_ok()
        {
            return Ok(candidate);
        }
    }
    allocate_port()
}

#[tauri::command]
async fn validate_proxy_config(config: serde_json::Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut check = core_command(&core_path()?)
            .args(["check", "-c", "stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动配置检查")?;
        let content = serde_json::to_vec(&config).map_err(|_| "代理配置无效")?;
        let written = check
            .stdin
            .take()
            .is_some_and(|mut input| input.write_all(&content).is_ok());
        let status = check.wait().map_err(|_| "无法完成配置检查")?;
        Ok(written && status.success())
    })
    .await
    .map_err(|_| "配置检查异常".to_string())?
}

#[tauri::command]
async fn start_proxy(
    config: serde_json::Value,
    mode: Option<String>,
    routing_mode: Option<network::RoutingMode>,
    auto_reconnect: Option<bool>,
    auto_failover: Option<bool>,
    fallback_groups: Option<Vec<Vec<String>>>,
    allow_lan: Option<bool>,
    bypass: Option<String>,
    tun_ipv6: Option<bool>,
    tun_stack: Option<String>,
    tun_strict_route: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let inbound = config
            .get("inbounds")
            .and_then(|x| x.as_array())
            .and_then(|x| x.first())
            .ok_or("缺少本地入口")?;
        let port = inbound
            .get("listen_port")
            .and_then(|v| v.as_u64())
            .filter(|v| (1024..=65535).contains(v))
            .ok_or("本地端口无效")? as u16;
        if inbound.get("listen").and_then(|x| x.as_str()) != Some("127.0.0.1")
            || inbound.get("type").and_then(|x| x.as_str()) != Some("mixed")
        {
            return Err("本地入口配置无效".into());
        }
        app.state::<ProxyState>().start(supervisor::Plan {
            settings: network::CoreSettings::singbox(config),
            port,
            mode: mode.unwrap_or_else(|| "local".into()),
            routing_mode: routing_mode.unwrap_or_default(),
            recover: auto_reconnect.unwrap_or(true),
            failover: auto_failover.unwrap_or(false),
            fallback_groups: fallback_groups.unwrap_or_default(),
            options: network::SessionOptions {
                allow_lan: allow_lan.unwrap_or(false),
                bypass,
                tun_ipv6: tun_ipv6.unwrap_or(true),
                tun_stack: mihomo::normalize_tun_stack(tun_stack.as_deref().unwrap_or("mixed"))
                    .to_owned(),
                tun_strict_route: tun_strict_route.unwrap_or(true),
            },
        })
    })
    .await
    .map_err(|_| "启动代理任务异常".to_string())?
}

#[tauri::command]
async fn start_mihomo(
    config: serde_json::Value,
    port: u16,
    mode: String,
    routing_mode: network::RoutingMode,
    auto_reconnect: bool,
    auto_failover: Option<bool>,
    selections: Option<std::collections::BTreeMap<String, String>>,
    allow_lan: Option<bool>,
    bypass: Option<String>,
    tun_ipv6: Option<bool>,
    tun_stack: Option<String>,
    tun_strict_route: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if port < 1024 {
        return Err("本地端口无效".into());
    }
    bundled_binary("mihomo.exe")?;
    if mode == "tun" {
        bundled_binary("wintun.dll")?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ProxyState>().start(supervisor::Plan {
            settings: network::CoreSettings {
                core: network::Core::Mihomo,
                config,
                selections: selections
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(group, choice)| {
                        !group.is_empty()
                            && group.len() <= 512
                            && !choice.is_empty()
                            && choice.len() <= 512
                    })
                    .take(128)
                    .collect(),
            },
            port,
            mode,
            routing_mode,
            recover: auto_reconnect,
            failover: auto_failover.unwrap_or(false),
            fallback_groups: Vec::new(),
            options: network::SessionOptions {
                allow_lan: allow_lan.unwrap_or(false),
                bypass,
                tun_ipv6: tun_ipv6.unwrap_or(true),
                tun_stack: mihomo::normalize_tun_stack(tun_stack.as_deref().unwrap_or("mixed"))
                    .to_owned(),
                tun_strict_route: tun_strict_route.unwrap_or(true),
            },
        })
    })
    .await
    .map_err(|_| "启动 Mihomo 任务异常".to_string())?
}

#[tauri::command]
async fn mihomo_groups(
    state: tauri::State<'_, ProxyState>,
) -> Result<Vec<telemetry::ProxyGroup>, String> {
    state.mihomo_groups().await
}

#[tauri::command]
async fn switch_mihomo_group(
    group: String,
    choice: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.switch_mihomo_group(&group, &choice).await
}

#[tauri::command]
async fn reload_mihomo(
    config: serde_json::Value,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.reload_mihomo(config).await
}

#[tauri::command]
async fn stop_proxy(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ProxyState>().stop())
        .await
        .map_err(|_| "停止代理任务异常".to_string())?
}

fn running_port(state: &ProxyState) -> Option<u16> {
    state.live().ok().flatten().map(|active| active.port)
}

#[tauri::command]
fn proxy_status(state: tauri::State<'_, ProxyState>) -> supervisor::Status {
    state.status()
}

#[tauri::command]
fn proxy_events(state: tauri::State<'_, ProxyState>) -> Result<Vec<supervisor::Event>, String> {
    state.events()
}

#[tauri::command]
fn clear_proxy_events(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    state.clear_events()
}

#[tauri::command]
fn set_dns_capture(enabled: bool, state: tauri::State<'_, ProxyState>) {
    state.set_dns_capture(enabled);
}

#[tauri::command]
fn proxy_dns_queries(state: tauri::State<'_, ProxyState>) -> Vec<telemetry::DnsLogEntry> {
    state.dns_queries()
}

#[tauri::command]
fn clear_dns_queries(state: tauri::State<'_, ProxyState>) {
    state.clear_dns_queries();
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DnsProbeBranch {
    ok: bool,
    answers: Vec<String>,
    is_fake_ip: bool,
    latency_ms: u64,
    error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DnsProbeReport {
    domain: String,
    qtype: String,
    topology_hint: String,
    local_os: DnsProbeBranch,
    core_internal: Option<DnsProbeBranch>,
    remote_doh: DnsProbeBranch,
}

#[tauri::command]
async fn probe_dns_resolution(
    domain: String,
    qtype: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<DnsProbeReport, String> {
    let normalized = domain
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 253
        || normalized.contains("://")
        || !normalized.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
    {
        return Err("请输入有效的域名，例如 api.openai.com".into());
    }
    let record_type = if qtype
        .as_deref()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("AAAA"))
    {
        "AAAA"
    } else {
        "A"
    };
    let expected_rr_type: u16 = if record_type == "AAAA" { 28 } else { 1 };

    let ctx = state.active_dns_context();
    let (active_port, controller, topology_hint) = match &ctx {
        None => (
            None,
            None,
            "代理未运行：本机直连系统 DNS；远程 DoH 对比直连 1.1.1.1".to_owned(),
        ),
        Some((network::Core::Singbox, mode, port, _)) if mode == "tun" => (
            Some(*port),
            None,
            "节点模式 + TUN：UDP/53 经 TUN 劫持分流至本机 bootstrap / 远程 1.1.1.1 DoH".to_owned(),
        ),
        Some((network::Core::Singbox, _, port, _)) => (
            Some(*port),
            None,
            "节点模式 + 系统/本地代理：浏览器等经代理域名由远端节点解析；本机系统探测走物理 DNS".to_owned(),
        ),
        Some((network::Core::Mihomo, mode, port, ctrl)) if mode == "tun" => (
            Some(*port),
            Some(ctrl.clone()),
            "Mihomo 原生 TUN：UDP/53 劫持进入 Mihomo DNS（Fake-IP / 策略组上游解析）".to_owned(),
        ),
        Some((network::Core::Mihomo, _, port, ctrl)) => (
            Some(*port),
            Some(ctrl.clone()),
            "Mihomo 系统/本地代理：可对照本机系统 DNS 与 Mihomo 内核 DNS（/dns/query）".to_owned(),
        ),
    };

    let local_fut = async {
        let started = std::time::Instant::now();
        match tokio::time::timeout(
            Duration::from_secs(4),
            tokio::net::lookup_host((normalized.as_str(), 443)),
        )
        .await
        {
            Ok(Ok(addrs)) => {
                let all: Vec<std::net::IpAddr> = addrs.map(|a| a.ip()).collect();
                let matching: Vec<std::net::IpAddr> = all
                    .iter()
                    .copied()
                    .filter(|ip| {
                        if record_type == "AAAA" {
                            ip.is_ipv6()
                        } else {
                            ip.is_ipv4()
                        }
                    })
                    .collect();
                let chosen = if matching.is_empty() { all } else { matching };
                let is_fake_ip = chosen.iter().copied().any(telemetry::is_fake_ip_addr);
                DnsProbeBranch {
                    ok: !chosen.is_empty(),
                    answers: chosen.into_iter().map(|ip| ip.to_string()).collect(),
                    is_fake_ip,
                    latency_ms: started.elapsed().as_millis() as u64,
                    error: None,
                }
            }
            Ok(Err(_)) => DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some("系统 DNS 解析失败".into()),
            },
            Err(_) => DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some("系统 DNS 解析超时".into()),
            },
        }
    };

    let core_fut = async {
        let ctrl = controller?;
        let started = std::time::Instant::now();
        match ctrl.query_dns(&normalized, record_type).await {
            Ok(val) => {
                let answers: Vec<String> = val
                    .get("Answer")
                    .and_then(|v| v.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|item| {
                                item.get("data")
                                    .and_then(|d| d.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let is_fake_ip = answers.iter().any(|item| {
                    item.parse::<std::net::IpAddr>()
                        .is_ok_and(telemetry::is_fake_ip_addr)
                });
                Some(DnsProbeBranch {
                    ok: !answers.is_empty(),
                    answers,
                    is_fake_ip,
                    latency_ms: started.elapsed().as_millis() as u64,
                    error: None,
                })
            }
            Err(err) => Some(DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some(err),
            }),
        }
    };

    let doh_fut = async {
        #[derive(serde::Deserialize)]
        struct DohAnswer {
            #[serde(rename = "type", default)]
            rtype: u16,
            #[serde(default)]
            data: String,
        }
        #[derive(serde::Deserialize)]
        struct DohResponse {
            #[serde(rename = "Answer", default)]
            answers: Vec<DohAnswer>,
        }
        let started = std::time::Instant::now();
        let builder = reqwest::Client::builder().timeout(Duration::from_secs(6));
        let client_res = if let Some(port) = active_port {
            match reqwest::Proxy::all(format!("http://127.0.0.1:{port}")) {
                Ok(proxy) => builder.no_proxy().proxy(proxy).build(),
                Err(e) => Err(e),
            }
        } else {
            builder.build()
        };
        let client = match client_res {
            Ok(c) => c,
            Err(_) => {
                return DnsProbeBranch {
                    ok: false,
                    answers: Vec::new(),
                    is_fake_ip: false,
                    latency_ms: 0,
                    error: Some("无法创建 DoH HTTP 客户端".into()),
                }
            }
        };
        let resp = match client
            .get("https://1.1.1.1/dns-query")
            .query(&[("name", normalized.as_str()), ("type", record_type)])
            .header("Accept", "application/dns-json")
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                return DnsProbeBranch {
                    ok: false,
                    answers: Vec::new(),
                    is_fake_ip: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    error: Some("远程 DoH 请求失败或超时".into()),
                }
            }
        };
        if !resp.status().is_success() {
            return DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some(format!("远程 DoH 返回 HTTP {}", resp.status().as_u16())),
            };
        }
        let Ok(bytes) = resp.bytes().await else {
            return DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some("读取远程 DoH 响应失败".into()),
            };
        };
        match serde_json::from_slice::<DohResponse>(&bytes) {
            Ok(parsed) => {
                let exact: Vec<String> = parsed
                    .answers
                    .iter()
                    .filter(|a| a.rtype == expected_rr_type && !a.data.trim().is_empty())
                    .map(|a| a.data.trim().to_owned())
                    .collect();
                let answers = if exact.is_empty() {
                    parsed
                        .answers
                        .into_iter()
                        .map(|a| a.data.trim().to_owned())
                        .filter(|s| !s.is_empty())
                        .collect()
                } else {
                    exact
                };
                DnsProbeBranch {
                    ok: !answers.is_empty(),
                    answers,
                    is_fake_ip: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    error: None,
                }
            }
            Err(_) => DnsProbeBranch {
                ok: false,
                answers: Vec::new(),
                is_fake_ip: false,
                latency_ms: started.elapsed().as_millis() as u64,
                error: Some("远程 DoH 响应解析失败".into()),
            },
        }
    };

    let (local_os, core_internal, remote_doh) = tokio::join!(local_fut, core_fut, doh_fut);
    Ok(DnsProbeReport {
        domain: normalized,
        qtype: record_type.to_owned(),
        topology_hint,
        local_os,
        core_internal,
        remote_doh,
    })
}

#[tauri::command]
fn set_global_hotkeys(
    config: hotkeys::HotkeyConfig,
    manager: tauri::State<'_, hotkeys::HotkeyManager>,
) -> Result<hotkeys::HotkeyApplyResult, String> {
    manager.apply(config)
}

#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let dir = logs::log_dir().ok_or("无法定位日志目录")?;
    Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|_| "无法打开日志目录")?;
    Ok(())
}

#[tauri::command]
fn open_project_repo() -> Result<(), String> {
    Command::new("explorer")
        .arg("https://github.com/Bailan766/RelayDesk")
        .spawn()
        .map_err(|_| "无法打开项目主页")?;
    Ok(())
}

#[tauri::command]
fn check_system_proxy_active(port: u16, state: tauri::State<'_, ProxyState>) -> bool {
    running_port(&state) == Some(port) && system_proxy::is_port_active(port)
}

fn apply_system_proxy_entry(port: u16, bypass: Option<&str>) -> Result<(), String> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("无法定位本地数据目录")?)
        .join("RelayDesk")
        .join("network-state");
    let _ = fs::create_dir_all(&dir);
    let journal = dir.join("proxy.json");
    let bypass_text = bypass.unwrap_or_default();
    system_proxy::enable_with_bypass(&journal, port, bypass_text)
        .map_err(|_| "无法重新写入 Windows 系统代理".into())
}

#[tauri::command]
fn repair_system_proxy(
    port: u16,
    bypass: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    if running_port(&state) != Some(port) {
        return Err("代理未在当前端口运行".into());
    }
    apply_system_proxy_entry(port, bypass.as_deref())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    release_url: String,
    download_url: Option<String>,
    mirror_download_url: Option<String>,
    expected_sha256: Option<String>,
    notes: String,
}

fn parse_semver(tag: &str) -> Option<(u64, u64, u64)> {
    let trimmed = tag.trim().trim_start_matches(['v', 'V']);
    if trimmed.contains('-') {
        return None;
    }
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn extract_sha256_digest(raw: Option<&str>) -> Option<String> {
    let hex = raw?.trim().strip_prefix("sha256:")?.trim();
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

#[tauri::command]
async fn check_app_update(state: tauri::State<'_, ProxyState>) -> Result<AppUpdateInfo, String> {
    #[derive(serde::Deserialize)]
    struct ReleaseAsset {
        name: String,
        browser_download_url: String,
        #[serde(default)]
        digest: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct LatestRelease {
        tag_name: String,
        html_url: String,
        body: Option<String>,
        #[serde(default)]
        assets: Vec<ReleaseAsset>,
    }
    let current = env!("CARGO_PKG_VERSION").to_owned();
    let local_port = running_port(&state);
    let direct_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(format!("RelayDesk/{current}"))
        .build()
        .map_err(|_| "无法初始化版本检查请求".to_string())?;
    let proxy_client = local_port.and_then(|port| {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).ok()?;
        reqwest::Client::builder()
            .no_proxy()
            .proxy(proxy)
            .timeout(Duration::from_secs(8))
            .user_agent(format!("RelayDesk/{current}"))
            .build()
            .ok()
    });
    const OFFICIAL_API: &str = "https://api.github.com/repos/Bailan766/RelayDesk/releases/latest";
    const MIRROR_API: &str = "https://gh-proxy.com/https://api.github.com/repos/Bailan766/RelayDesk/releases/latest";
    let mut release: Option<LatestRelease> = None;
    if let Some(client) = &proxy_client {
        if let Ok(resp) = client.get(OFFICIAL_API).send().await {
            if let Ok(ok) = resp.error_for_status() {
                if let Ok(bytes) = ok.bytes().await {
                    release = serde_json::from_slice::<LatestRelease>(&bytes).ok();
                }
            }
        }
    }
    if release.is_none() {
        for endpoint in [OFFICIAL_API, MIRROR_API] {
            if let Ok(resp) = direct_client.get(endpoint).send().await {
                if let Ok(ok) = resp.error_for_status() {
                    if let Ok(bytes) = ok.bytes().await {
                        if let Ok(parsed) = serde_json::from_slice::<LatestRelease>(&bytes) {
                            release = Some(parsed);
                            break;
                        }
                    }
                }
            }
        }
    }
    let release = release.ok_or_else(|| "无法从 GitHub 或 gh-proxy 加速源检查更新，请稍后重试".to_string())?;
    let latest_clean = release.tag_name.trim().trim_start_matches(['v', 'V']).to_owned();
    let has_update = match (parse_semver(&current), parse_semver(&release.tag_name)) {
        (Some(cur), Some(lat)) => lat > cur,
        _ => false,
    };
    let installer_asset = release.assets.into_iter().find(|a| {
        a.name.ends_with("-setup.exe")
            && a.browser_download_url
                .starts_with("https://github.com/Bailan766/RelayDesk/releases/download/")
    });
    let expected_sha256 = installer_asset
        .as_ref()
        .and_then(|a| extract_sha256_digest(a.digest.as_deref()));
    let download_url = installer_asset.map(|a| a.browser_download_url);
    let mirror_download_url = download_url
        .as_ref()
        .map(|url| format!("https://gh-proxy.com/{url}"));
    let release_url = if release.html_url.starts_with("https://github.com/Bailan766/RelayDesk/releases") {
        release.html_url
    } else {
        "https://github.com/Bailan766/RelayDesk/releases".to_owned()
    };
    let notes = release
        .body
        .unwrap_or_default()
        .lines()
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(AppUpdateInfo {
        current,
        latest: latest_clean,
        has_update,
        release_url,
        download_url,
        mirror_download_url,
        expected_sha256,
        notes,
    })
}

#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
    let allowed = url == "https://github.com/Bailan766/RelayDesk/releases"
        || url.starts_with("https://github.com/Bailan766/RelayDesk/releases/")
        || url.starts_with("https://gh-proxy.com/https://github.com/Bailan766/RelayDesk/releases/");
    if !allowed {
        return Err("不支持打开非官方发布地址".into());
    }
    Command::new("explorer")
        .arg(url)
        .spawn()
        .map_err(|_| "无法打开下载页面")?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    stage: &'static str,
}

#[tauri::command]
async fn download_and_install_update(
    download_url: String,
    expected_sha256: Option<String>,
    use_mirror: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> Result<bool, String> {
    use sha2::{Digest, Sha256};

    if !download_url.starts_with("https://github.com/Bailan766/RelayDesk/releases/download/")
        || !download_url.ends_with("-setup.exe")
    {
        return Err("非官方安装包下载地址，已拒绝下载".into());
    }
    let expected = match expected_sha256 {
        Some(raw) => {
            let trimmed = raw.trim().to_ascii_lowercase();
            if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("安装包的 SHA-256 摘要格式无效".into());
            }
            Some(trimmed)
        }
        None => None,
    };

    let target_url = if use_mirror {
        format!("https://gh-proxy.com/{download_url}")
    } else {
        download_url.clone()
    };
    let current = env!("CARGO_PKG_VERSION").to_owned();
    let client = if !use_mirror {
        if let Some(port) = running_port(&state) {
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|_| "无法通过当前代理下载更新")?;
            reqwest::Client::builder()
                .no_proxy()
                .proxy(proxy)
                .timeout(Duration::from_secs(180))
                .user_agent(format!("RelayDesk/{current}"))
                .build()
                .map_err(|_| "无法初始化下载器")?
        } else {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .user_agent(format!("RelayDesk/{current}"))
                .build()
                .map_err(|_| "无法初始化下载器")?
        }
    } else {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .user_agent(format!("RelayDesk/{current}"))
            .build()
            .map_err(|_| "无法初始化加速下载器")?
    };

    let mut response = client
        .get(&target_url)
        .send()
        .await
        .map_err(|_| "下载安装包失败，请检查网络或切换下载线路".to_string())?
        .error_for_status()
        .map_err(|status| format!("下载服务器返回异常（HTTP {:?}）", status.status().map(|s| s.as_u16())))?;

    const MAX_INSTALLER_BYTES: u64 = 128 * 1024 * 1024;
    let total = response.content_length();
    if total.is_some_and(|len| len > MAX_INSTALLER_BYTES) {
        return Err("安装包体积异常（超过 128 MB），已中止下载".into());
    }

    let part_path = std::env::temp_dir().join(format!(
        "RelayDesk-update-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let final_path = std::env::temp_dir().join("RelayDesk-update-setup.exe");
    let _cleanup_part = TemporaryConfig(part_path.clone());

    let mut file = fs::File::create(&part_path).map_err(|_| "无法创建临时安装文件")?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut header = [0u8; 2];
    let mut header_len = 0usize;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = response.chunk().await.map_err(|_| "读取安装包数据流中断")? {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_INSTALLER_BYTES {
            return Err("安装包体积超出限制，已中止下载".into());
        }
        if header_len < 2 {
            let need = (2 - header_len).min(chunk.len());
            header[header_len..header_len + need].copy_from_slice(&chunk[..need]);
            header_len += need;
        }
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|_| "写入临时安装包失败")?;
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "update-download-progress",
                UpdateDownloadProgress {
                    downloaded,
                    total,
                    stage: "downloading",
                },
            );
        }
    }
    file.flush().map_err(|_| "写入安装包缓冲区失败")?;
    drop(file);

    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded,
            total,
            stage: "verifying",
        },
    );

    if downloaded < 1024 * 1024 || header_len < 2 || header != *b"MZ" {
        return Err("下载内容不是有效的 Windows 安装包".into());
    }

    let actual_hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let sha256_verified = match expected {
        Some(exp) => {
            if actual_hex != exp {
                return Err(format!("安装包 SHA-256 校验失败，已中止安装"));
            }
            true
        }
        None => false,
    };

    let _ = fs::remove_file(&final_path);
    fs::rename(&part_path, &final_path).map_err(|_| "无法准备更新安装文件")?;

    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded,
            total: Some(downloaded),
            stage: "installing",
        },
    );

    let relaunch_exe = std::env::current_exe()
        .ok()
        .unwrap_or_else(|| PathBuf::from("relaydesk.exe"));
    let pid = std::process::id().to_string();

    let stop_app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = stop_app.state::<ProxyState>().shutdown();
    })
    .await;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = "Wait-Process -Id ([int]$env:RELAYDESK_PARENT_PID) -Timeout 15 -ErrorAction SilentlyContinue; \
                      $p = Start-Process -FilePath $env:RELAYDESK_UPDATER_EXE -ArgumentList '/S' -Wait -PassThru; \
                      if ($p.ExitCode -eq 0 -and (Test-Path $env:RELAYDESK_TARGET_EXE)) { Start-Process -FilePath $env:RELAYDESK_TARGET_EXE }";
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
            .env("RELAYDESK_PARENT_PID", &pid)
            .env("RELAYDESK_UPDATER_EXE", &final_path)
            .env("RELAYDESK_TARGET_EXE", &relaunch_exe)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|_| "无法拉起静默安装程序")?;
    }

    app.exit(0);
    Ok(sha256_verified)
}

#[tauri::command]
async fn probe_loaded_node(
    tag: String,
    probe_url: Option<String>,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, ProxyState>,
) -> Result<u64, String> {
    let url = probe_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .unwrap_or("https://www.gstatic.com/generate_204");
    state
        .probe_delay(&tag, url, timeout_ms.unwrap_or(5000))
        .await
}

#[tauri::command]
async fn probe_mihomo_group(
    group: String,
    probe_url: Option<String>,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, ProxyState>,
) -> Result<std::collections::BTreeMap<String, u64>, String> {
    let url = probe_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .unwrap_or("https://www.gstatic.com/generate_204");
    state
        .probe_group_delays(&group, url, timeout_ms.unwrap_or(5000))
        .await
}

#[tauri::command]
async fn close_proxy_connection(
    id: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.close_connection(&id).await
}

#[tauri::command]
async fn close_all_connections(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    state.close_all_connections().await
}

#[tauri::command]
fn get_tun_service_status() -> service::ServiceStatusInfo {
    service::query_status()
}

#[tauri::command]
async fn install_tun_service(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.state::<ProxyState>().stop();
        service::install_elevated()
    })
    .await
    .map_err(|_| "安装后台服务任务异常".to_string())?
}

#[tauri::command]
async fn uninstall_tun_service(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.state::<ProxyState>().stop();
        service::uninstall_elevated()
    })
    .await
    .map_err(|_| "卸载后台服务任务异常".to_string())?
}

#[tauri::command]
fn is_elevated() -> bool {
    network::is_elevated()
}

#[tauri::command]
fn relaunch_elevated(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::shellapi::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    let _ = app.state::<ProxyState>().shutdown();
    release_single_instance();
    let exe = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain([0]).collect::<Vec<u16>>();
    let file = wide(exe.as_os_str());
    let verb = wide(std::ffi::OsStr::new("runas"));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = 1;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err("未获得管理员权限授权".into());
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(windows)]
    {
        win_reg::is_enabled()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_reg::set_enabled(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("仅支持 Windows 开机自启".into())
    }
}

#[tauri::command]
fn set_close_action(exit_on_close: bool, prefs: tauri::State<'_, AppPreferences>) {
    prefs.exit_on_close.store(exit_on_close, Ordering::Release);
}

#[tauri::command]
fn set_system_proxy_guard(enabled: bool, prefs: tauri::State<'_, AppPreferences>) {
    prefs.system_proxy_guard.store(enabled, Ordering::Release);
}

#[derive(serde::Deserialize)]
struct TrayQuickChoice {
    id: String,
    label: String,
    selected: bool,
}

#[tauri::command]
fn update_tray_state(
    running: bool,
    summary: String,
    routing_mode: String,
    entry_mode: Option<String>,
    quick_choices: Option<Vec<TrayQuickChoice>>,
    app: tauri::AppHandle,
) {
    let entry = entry_mode.unwrap_or_else(|| "system".to_owned());
    if let Some(ui) = app.try_state::<TrayUi>() {
        let status_text = if running {
            format!("状态：运行中 · {summary}")
        } else {
            "状态：未连接".to_owned()
        };
        let _ = ui.status.set_text(&status_text);
        let _ = ui.toggle.set_text(if running { "断开代理" } else { "连接代理" });
        let _ = ui.rule.set_checked(routing_mode == "rule");
        let _ = ui.global.set_checked(routing_mode == "global");
        let _ = ui.direct.set_checked(routing_mode == "direct");
        let _ = ui.entry_system.set_checked(entry == "system");
        let _ = ui.entry_tun.set_checked(entry == "tun");
        let _ = ui.entry_local.set_checked(entry == "local");
        if let Some(choices) = quick_choices {
            let trimmed: Vec<TrayQuickChoice> = choices.into_iter().take(8).collect();
            let sig = trimmed
                .iter()
                .map(|c| format!("{}:{}:{}", c.id, c.label, c.selected))
                .collect::<Vec<_>>()
                .join("|");
            let changed = ui
                .quick_sig
                .lock()
                .map(|mut prev| {
                    if *prev == sig {
                        false
                    } else {
                        *prev = sig;
                        true
                    }
                })
                .unwrap_or(false);
            if changed {
                while matches!(ui.quick_menu.remove_at(0), Ok(Some(_))) {}
                if trimmed.is_empty() {
                    if let Ok(empty) = tauri::menu::MenuItem::with_id(
                        &app,
                        "pick_empty",
                        "暂无可切换节点",
                        false,
                        None::<&str>,
                    ) {
                        let _ = ui.quick_menu.append(&empty);
                    }
                } else {
                    for choice in trimmed {
                        if let Ok(item) = tauri::menu::CheckMenuItem::with_id(
                            &app,
                            format!("pick:{}", choice.id),
                            choice.label,
                            true,
                            choice.selected,
                            None::<&str>,
                        ) {
                            let _ = ui.quick_menu.append(&item);
                        }
                    }
                }
            }
        }
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tip = if running {
            format!("RelayDesk · {summary}")
        } else {
            "RelayDesk · 未连接".to_owned()
        };
        let _ = tray.set_tooltip(Some(&tip));
    }
}

#[tauri::command]
async fn configure_recovery(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ProxyState>().configure_recovery(enabled)
    })
    .await
    .map_err(|_| "更新自动恢复设置异常".to_string())?
}
#[tauri::command]
async fn switch_proxy_node(tag: String, state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    state.switch_node(tag).await
}

#[tauri::command]
async fn configure_failover(
    enabled: bool,
    fallback_groups: Vec<Vec<String>>,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.configure_failover(enabled, fallback_groups).await
}

#[tauri::command]
async fn set_routing_mode(
    mode: network::RoutingMode,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.change_mode(mode).await
}

#[tauri::command]
async fn proxy_telemetry(
    state: tauri::State<'_, ProxyState>,
) -> Result<Option<telemetry::SessionSnapshot>, String> {
    let Some(active) = state.live()? else {
        return Ok(None);
    };
    let snapshot = active.controller.snapshot().await;
    if !state
        .live()?
        .is_some_and(|current| current.id == active.id && current.generation == active.generation)
    {
        return Ok(None);
    }
    snapshot.map(|snapshot| {
        Some(telemetry::SessionSnapshot {
            session_id: if active.generation == 0 {
                active.id
            } else {
                format!("{}:{}", active.id, active.generation)
            },
            snapshot,
        })
    })
}
#[tauri::command]
async fn check_connection(
    port: u16,
    probe_url: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<u128, String> {
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
    let url = probe_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .unwrap_or("https://www.gstatic.com/generate_204");
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "本地代理地址无效")?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法启动连接检查")?;
    let started = std::time::Instant::now();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "代理请求失败或超时，请检查节点和网络")?;
    if !response.status().is_success() && response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("检查地址返回异常状态，连接未确认".into());
    }
    Ok(started.elapsed().as_millis())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum Website {
    Apple,
    Github,
    Google,
    Youtube,
}

#[derive(serde::Serialize)]
struct WebsiteResult {
    status: u16,
    milliseconds: u64,
}

#[tauri::command]
async fn check_website(
    site: Website,
    port: u16,
    state: tauri::State<'_, ProxyState>,
) -> Result<WebsiteResult, String> {
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
    let target = match site {
        Website::Apple => "https://www.apple.com/",
        Website::Github => "https://github.com/robots.txt",
        Website::Google => "https://www.gstatic.com/generate_204",
        Website::Youtube => "https://www.youtube.com/robots.txt",
    };
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "无法启动网站测试")?;
    let start = std::time::Instant::now();
    let response = client.get(target).send().await.map_err(|error| {
        if error.is_timeout() {
            "请求超时"
        } else if error.is_connect() {
            "连接或 TLS 握手失败"
        } else {
            "未收到 HTTP 响应"
        }
    })?;
    Ok(WebsiteResult {
        status: response.status().as_u16(),
        milliseconds: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
async fn measure_download(
    port: u16,
    state: tauri::State<'_, ProxyState>,
) -> Result<probes::DownloadMeasurement, String> {
    let active = state
        .live()?
        .filter(|active| active.port == port)
        .ok_or("代理内核未运行")?;
    let measurement = probes::measure_download(port).await?;
    if !state.live()?.is_some_and(|current| {
        current.id == active.id
            && current.generation == active.generation
            && current.route_revision == active.route_revision
    }) {
        return Err("测试期间代理线路已变化，请重新测试".into());
    }
    Ok(measurement)
}

#[derive(Default, serde::Serialize)]
struct SubscriptionUsage {
    upload: Option<u64>,
    download: Option<u64>,
    total: Option<u64>,
    expire: Option<u64>,
}

fn subscription_usage(headers: &reqwest::header::HeaderMap) -> Option<SubscriptionUsage> {
    let value = headers.get("subscription-userinfo")?.to_str().ok()?;
    let mut usage = SubscriptionUsage::default();
    for (name, raw) in value.split(';').filter_map(|field| field.split_once('=')) {
        let Ok(amount) = raw.trim().parse::<u64>() else {
            continue;
        };
        if amount > 9_007_199_254_740_991 {
            continue;
        }
        match name.trim().to_ascii_lowercase().as_str() {
            "upload" => usage.upload = Some(amount),
            "download" => usage.download = Some(amount),
            "total" => usage.total = Some(amount),
            "expire" => usage.expire = Some(amount),
            _ => (),
        }
    }
    (usage.upload.is_some()
        || usage.download.is_some()
        || usage.total.is_some()
        || usage.expire.is_some())
    .then_some(usage)
}

#[derive(serde::Serialize)]
struct SubscriptionDownload {
    content: String,
    usage: Option<SubscriptionUsage>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum SubscriptionRoute {
    #[default]
    Automatic,
    Direct,
    Relaydesk,
}

#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SubscriptionRequest {
    route: SubscriptionRoute,
    user_agent: String,
    allow_http: bool,
}

fn is_local_or_private_http(target: &url::Url) -> bool {
    if target.scheme() != "http" {
        return false;
    }
    let Some(host) = target.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local()
        }
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

fn subscription_url_allowed(target: &url::Url, allow_http: bool) -> bool {
    if target.host_str().is_none() || !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    target.scheme() == "https"
        || is_local_or_private_http(target)
        || (allow_http && target.scheme() == "http")
}

fn subscription_http_client(
    request: SubscriptionRequest,
    port: Option<u16>,
) -> Result<reqwest::Client, String> {
    let allow_http = request.allow_http;
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let target = attempt.url();
            if attempt.previous().len() > 3 || !subscription_url_allowed(target, allow_http) {
                attempt.error("invalid subscription redirect")
            } else {
                attempt.follow()
            }
        }));
    builder = match request.route {
        SubscriptionRoute::Automatic => builder,
        SubscriptionRoute::Direct => builder.no_proxy(),
        SubscriptionRoute::Relaydesk => {
            let port = port.ok_or("请先连接 RelayDesk，再通过当前代理更新订阅")?;
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|_| "无法使用当前代理入口")?;
            builder.no_proxy().proxy(proxy)
        }
    };
    let agent = request.user_agent.trim();
    if !agent.is_empty() {
        if agent.len() > 256 || !agent.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
            return Err("客户端标识只能包含可见英文字符，最多 256 字符".into());
        }
        builder = builder.user_agent(agent);
    }
    builder.build().map_err(|_| "无法初始化网络请求".into())
}

#[tauri::command]
async fn fetch_subscription(
    address: String,
    request: Option<SubscriptionRequest>,
    state: tauri::State<'_, ProxyState>,
) -> Result<SubscriptionDownload, String> {
    let parsed = url::Url::parse(&address).map_err(|_| "订阅地址无效")?;
    let request = request.unwrap_or_default();
    if !subscription_url_allowed(&parsed, request.allow_http) {
        return Err("请输入不含账号密码的 HTTPS 订阅地址（或内网 HTTP / 在请求设置中允许 HTTP）".into());
    }
    let port = if matches!(&request.route, SubscriptionRoute::Relaydesk) {
        running_port(&state)
    } else {
        None
    };
    let client = subscription_http_client(request, port)?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "订阅请求失败，请检查网络")?;
    if !response.status().is_success() {
        return Err(format!(
            "订阅服务器返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let usage = subscription_usage(response.headers());
    const LIMIT: usize = 4 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        return Err("订阅内容超过 4 MB".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取订阅失败")? {
        if data.len() + chunk.len() > LIMIT {
            return Err("订阅内容超过 4 MB".into());
        }
        data.extend_from_slice(&chunk);
    }
    let content = String::from_utf8(data).map_err(|_| "订阅内容不是 UTF-8 文本")?;
    Ok(SubscriptionDownload { content, usage })
}

#[cfg(test)]
mod subscription_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn explicit_subscription_routes_send_the_custom_header_and_do_not_fall_back() {
        async fn fixture() -> (u16, tokio::task::JoinHandle<String>) {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            let capture = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") && headers.len() < 4096 {
                    headers.push(socket.read_u8().await.unwrap());
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture",
                    )
                    .await
                    .unwrap();
                String::from_utf8(headers).unwrap().to_ascii_lowercase()
            });
            (port, capture)
        }

        let request = |route| SubscriptionRequest {
            route,
            user_agent: " RelayDesk-Fixture/1.0 ".into(),
            allow_http: false,
        };
        assert!(subscription_http_client(request(SubscriptionRoute::Relaydesk), None).is_err());

        for through_proxy in [false, true] {
            let (port, capture) = fixture().await;
            let (client, url, path) = if through_proxy {
                (
                    subscription_http_client(request(SubscriptionRoute::Relaydesk), Some(port))
                        .unwrap(),
                    "http://subscription.fixture.test/nodes".to_owned(),
                    "get http://subscription.fixture.test/nodes http/1.1",
                )
            } else {
                (
                    subscription_http_client(request(SubscriptionRoute::Direct), None).unwrap(),
                    format!("http://127.0.0.1:{port}/nodes"),
                    "get /nodes http/1.1",
                )
            };
            let response = client
                .get(url)
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "fixture");
            let headers = capture.await.unwrap();
            assert!(headers.starts_with(path));
            assert!(headers.contains("\r\nuser-agent: relaydesk-fixture/1.0\r\n"));
        }
    }
}

struct AppPreferences {
    exit_on_close: AtomicBool,
    system_proxy_guard: AtomicBool,
    proxy_guard_stop: std::sync::Arc<AtomicBool>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            exit_on_close: AtomicBool::new(false),
            system_proxy_guard: AtomicBool::new(true),
            proxy_guard_stop: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemProxyGuardEvent {
    status: &'static str,
}

#[cfg(windows)]
mod single_instance {
    use std::{os::windows::ffi::OsStrExt, ptr, sync::Mutex};
    use winapi::{
        shared::winerror::ERROR_ALREADY_EXISTS,
        um::{
            errhandlingapi::GetLastError,
            handleapi::CloseHandle,
            synchapi::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
            winbase::{WAIT_ABANDONED, WAIT_OBJECT_0},
            winnt::HANDLE,
            winuser::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE},
        },
    };

    static HOLDER: Mutex<usize> = Mutex::new(0);

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain([0]).collect()
    }

    pub fn acquire_or_exit() {
        let name = wide("Local\\RelayDesk.SingleInstance.v1");
        let handle = unsafe { CreateMutexW(ptr::null_mut(), 1, name.as_ptr()) };
        if handle.is_null() {
            return;
        }
        let already = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if already {
            let waited = unsafe { WaitForSingleObject(handle, 800) };
            if !matches!(waited, WAIT_OBJECT_0 | WAIT_ABANDONED) {
                let title = wide("RelayDesk");
                let hwnd = unsafe { FindWindowW(ptr::null(), title.as_ptr()) };
                if !hwnd.is_null() {
                    unsafe {
                        ShowWindow(hwnd, SW_RESTORE);
                        SetForegroundWindow(hwnd);
                    }
                }
                unsafe {
                    CloseHandle(handle);
                }
                std::process::exit(0);
            }
        }
        if let Ok(mut guard) = HOLDER.lock() {
            *guard = handle as usize;
        }
    }

    pub fn release() {
        if let Ok(mut guard) = HOLDER.lock() {
            let raw = std::mem::take(&mut *guard);
            if raw != 0 {
                let handle = raw as HANDLE;
                unsafe {
                    ReleaseMutex(handle);
                    CloseHandle(handle);
                }
            }
        }
    }
}

fn release_single_instance() {
    #[cfg(windows)]
    single_instance::release();
}

struct TrayUi {
    status: tauri::menu::MenuItem<tauri::Wry>,
    toggle: tauri::menu::MenuItem<tauri::Wry>,
    rule: tauri::menu::CheckMenuItem<tauri::Wry>,
    global: tauri::menu::CheckMenuItem<tauri::Wry>,
    direct: tauri::menu::CheckMenuItem<tauri::Wry>,
    entry_system: tauri::menu::CheckMenuItem<tauri::Wry>,
    entry_tun: tauri::menu::CheckMenuItem<tauri::Wry>,
    entry_local: tauri::menu::CheckMenuItem<tauri::Wry>,
    quick_menu: tauri::menu::Submenu<tauri::Wry>,
    quick_sig: std::sync::Mutex<String>,
}

#[cfg(windows)]
mod win_reg {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    type Hkey = *mut c_void;
    const HKEY_CURRENT_USER: Hkey = 0x8000_0001usize as Hkey;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "RelayDesk";

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: Hkey,
            sub_key: *const u16,
            options: u32,
            sam: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: Hkey,
            value_name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            hkey: Hkey,
            value_name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            size: u32,
        ) -> i32;
        fn RegDeleteValueW(hkey: Hkey, value_name: *const u16) -> i32;
        fn RegCloseKey(hkey: Hkey) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text).encode_wide().chain([0]).collect()
    }

    pub fn is_enabled() -> bool {
        let subkey = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut key: Hkey = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_QUERY_VALUE, &mut key) }
            != 0
        {
            return false;
        }
        let mut kind = 0u32;
        let mut size = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        unsafe { RegCloseKey(key) };
        status == 0 && kind == REG_SZ && size > 2
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let subkey = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut key: Hkey = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_SET_VALUE, &mut key) }
            != 0
        {
            return Err("无法打开 Windows 启动项注册表".into());
        }
        let status = if enabled {
            let Ok(exe) = std::env::current_exe() else {
                unsafe { RegCloseKey(key) };
                return Err("无法定位程序路径".into());
            };
            let command = wide(&format!("\"{}\"", exe.to_string_lossy()));
            let bytes = (command.len() * std::mem::size_of::<u16>()) as u32;
            unsafe {
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    command.as_ptr().cast(),
                    bytes,
                )
            }
        } else {
            let code = unsafe { RegDeleteValueW(key, name.as_ptr()) };
            if code == 2 {
                0
            } else {
                code
            }
        };
        unsafe { RegCloseKey(key) };
        if status == 0 {
            Ok(())
        } else {
            Err("无法更新 Windows 开机自启设置".into())
        }
    }
}

fn main() {
    if let Some(code) = service::cli() {
        std::process::exit(code);
    }
    if let Some(code) = network::cli() {
        std::process::exit(code);
    }
    #[cfg(windows)]
    single_instance::acquire_or_exit();
    let _ = network::recover();
    let app = tauri::Builder::default()
        .manage(ProxyState::default())
        .manage(probes::ProbeBatch::default())
        .manage(probes::ProbeSessions::default())
        .manage(AppPreferences::default())
        .setup(|app| {
            use tauri::{
                menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            let status = MenuItem::with_id(app, "status", "状态：未连接", false, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let show = MenuItem::with_id(app, "show", "打开 RelayDesk", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "连接代理", true, None::<&str>)?;
            let rule = CheckMenuItem::with_id(app, "mode_rule", "规则模式", true, true, None::<&str>)?;
            let global = CheckMenuItem::with_id(app, "mode_global", "全局模式", true, false, None::<&str>)?;
            let direct = CheckMenuItem::with_id(app, "mode_direct", "直连模式", true, false, None::<&str>)?;
            let mode_menu = Submenu::with_items(app, "路由模式", true, &[&rule, &global, &direct])?;
            let entry_system = CheckMenuItem::with_id(app, "entry_system", "系统代理", true, true, None::<&str>)?;
            let entry_tun = CheckMenuItem::with_id(app, "entry_tun", "TUN 虚拟网卡", true, false, None::<&str>)?;
            let entry_local = CheckMenuItem::with_id(app, "entry_local", "仅本地端口", true, false, None::<&str>)?;
            let entry_menu = Submenu::with_items(app, "接管方式", true, &[&entry_system, &entry_tun, &entry_local])?;
            let quick_empty = MenuItem::with_id(app, "pick_empty", "暂无可切换节点", false, None::<&str>)?;
            let quick_menu = Submenu::with_items(app, "快捷切换", true, &[&quick_empty])?;
            let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&status, &sep1, &show, &toggle, &quick_menu, &mode_menu, &entry_menu, &stop, &sep2, &quit],
            )?;
            app.manage(TrayUi {
                status,
                toggle,
                rule,
                global,
                direct,
                entry_system,
                entry_tun,
                entry_local,
                quick_menu,
                quick_sig: std::sync::Mutex::new(String::new()),
            });
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("RelayDesk · 未连接")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id.starts_with("pick:") {
                        let _ = app.emit("tray-action", id);
                        return;
                    }
                    match id {
                        "show" => show_main(app),
                        "toggle" => {
                            let _ = app.emit("tray-action", "toggle");
                        }
                        "mode_rule" => {
                            let _ = app.emit("tray-action", "mode:rule");
                        }
                        "mode_global" => {
                            let _ = app.emit("tray-action", "mode:global");
                        }
                        "mode_direct" => {
                            let _ = app.emit("tray-action", "mode:direct");
                        }
                        "entry_system" => {
                            let _ = app.emit("tray-action", "entry:system");
                        }
                        "entry_tun" => {
                            let _ = app.emit("tray-action", "entry:tun");
                        }
                        "entry_local" => {
                            let _ = app.emit("tray-action", "entry:local");
                        }
                        "stop" => {
                            let app = app.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                let _ = app.state::<ProxyState>().stop();
                            });
                        }
                        "quit" => app.exit(0),
                        _ => (),
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            app.state::<ProxyState>().load_persisted_events();
            let hk_manager = hotkeys::HotkeyManager::start(app.handle().clone())
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            app.manage(hk_manager);
            netwatch::start(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || ProxyState::run(handle));
            let guard_app = app.handle().clone();
            let guard_stop = std::sync::Arc::clone(&app.state::<AppPreferences>().proxy_guard_stop);
            let repair_times = std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::VecDeque::<std::time::Instant>::new(),
            ));
            let warned_ratelimit = std::sync::Arc::new(AtomicBool::new(false));
            system_proxy::watch_internet_settings(guard_stop, move || {
                let state = guard_app.state::<ProxyState>();
                let Some((port, _, uptime)) = state.active_system_proxy() else {
                    return;
                };
                if uptime < Duration::from_secs(2) || system_proxy::is_port_active(port) {
                    warned_ratelimit.store(false, Ordering::Release);
                    return;
                }
                std::thread::sleep(Duration::from_millis(300));
                let Some((rechecked_port, bypass, _)) = state.active_system_proxy() else {
                    return;
                };
                if rechecked_port != port || system_proxy::is_port_active(rechecked_port) {
                    return;
                }
                if guard_app
                    .state::<AppPreferences>()
                    .system_proxy_guard
                    .load(Ordering::Acquire)
                {
                    let allow_repair = repair_times
                        .lock()
                        .map(|mut times| {
                            let now = std::time::Instant::now();
                            while times
                                .front()
                                .is_some_and(|t| now.saturating_duration_since(*t) > Duration::from_secs(30))
                            {
                                times.pop_front();
                            }
                            if times.len() < 3 {
                                times.push_back(now);
                                true
                            } else {
                                false
                            }
                        })
                        .unwrap_or(false);
                    if allow_repair {
                        if apply_system_proxy_entry(rechecked_port, bypass.as_deref()).is_ok() {
                            warned_ratelimit.store(false, Ordering::Release);
                            state.record_notice("info", "检测到系统代理被外部程序修改，已自动写回守护");
                            let _ = guard_app.emit(
                                "system-proxy-guard",
                                SystemProxyGuardEvent { status: "repaired" },
                            );
                            return;
                        }
                    } else if !warned_ratelimit.swap(true, Ordering::AcqRel) {
                        state.record_notice("warn", "检测到其他程序反复篡改系统代理，已暂停自动写回并转为提醒");
                    }
                }
                let _ = guard_app.emit(
                    "system-proxy-guard",
                    SystemProxyGuardEvent { status: "tampered" },
                );
            });
            tauri::async_runtime::spawn(ProxyState::watch_core_logs(app.handle().clone()));
            tauri::async_runtime::spawn(ProxyState::watch_dns_logs(app.handle().clone()));
            tauri::async_runtime::spawn(ProxyState::watch_nodes(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let exit = window
                    .app_handle()
                    .state::<AppPreferences>()
                    .exit_on_close
                    .load(Ordering::Acquire);
                if !exit {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            fetch_subscription,
            allocate_port,
            allocate_stable_port,
            validate_proxy_config,
            start_proxy,
            start_mihomo,
            mihomo_groups,
            switch_mihomo_group,
            reload_mihomo,
            stop_proxy,
            proxy_status,
            proxy_events,
            clear_proxy_events,
            set_dns_capture,
            proxy_dns_queries,
            clear_dns_queries,
            probe_dns_resolution,
            set_global_hotkeys,
            open_log_folder,
            open_project_repo,
            check_system_proxy_active,
            repair_system_proxy,
            check_app_update,
            open_release_page,
            download_and_install_update,
            probe_loaded_node,
            probe_mihomo_group,
            close_proxy_connection,
            close_all_connections,
            configure_recovery,
            configure_failover,
            switch_proxy_node,
            set_routing_mode,
            proxy_telemetry,
            check_connection,
            check_website,
            measure_download,
            probes::begin_probe_batch,
            probes::cancel_probe_batch,
            probes::probe_node,
            probes::start_probe_session,
            probes::probe_session_node,
            probes::stop_probe_session,
            probes::probe_tcp_latency,
            check_exit_ip,
            check_exit_ip_detail,
            check_unlock_service,
            local_tcp_google,
            is_elevated,
            get_tun_service_status,
            install_tun_service,
            uninstall_tun_service,
            relaunch_elevated,
            get_autostart,
            set_autostart,
            set_close_action,
            set_system_proxy_guard,
            update_tray_state,
            storage::save_subscription,
            storage::load_subscription
        ])
        .build(tauri::generate_context!())
        .expect("failed to build RelayDesk");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(prefs) = handle.try_state::<AppPreferences>() {
                prefs.proxy_guard_stop.store(true, Ordering::Release);
            }
            if let Some(hk) = handle.try_state::<hotkeys::HotkeyManager>() {
                hk.shutdown();
            }
            let state = handle.state::<ProxyState>();
            let _ = state.shutdown();
            release_single_instance();
        }
    });
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}


#[cfg(test)]
mod updater_tests {
    use super::{extract_sha256_digest, parse_semver};

    #[test]
    fn parses_clean_semver_tags_and_ignores_prereleases() {
        assert_eq!(parse_semver("v1.4.0"), Some((1, 4, 0)));
        assert_eq!(parse_semver("1.3.2"), Some((1, 3, 2)));
        assert!(parse_semver("v1.4.0") > parse_semver("1.3.9"));
        assert_eq!(parse_semver("v1.4.0-beta.1"), None);
        assert_eq!(parse_semver("invalid"), None);
    }

    #[test]
    fn validates_sha256_asset_digests() {
        let valid = "sha256:7412C2DE2EBAA756FF7D416AA9485B4500B56C4F423FDA0F03925A1561E66DF3";
        assert_eq!(
            extract_sha256_digest(Some(valid)).as_deref(),
            Some("7412c2de2ebaa756ff7d416aa9485b4500b56c4f423fda0f03925a1561e66df3")
        );
        assert_eq!(extract_sha256_digest(Some("sha256:short")), None);
        assert_eq!(extract_sha256_digest(Some("md5:1234")), None);
        assert_eq!(extract_sha256_digest(None), None);
    }
}
