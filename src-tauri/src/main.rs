#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tauri::Manager;
mod failover;
mod network;
mod probes;
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
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化出口检查")?;
    let response = client
        .get("https://api.ipify.org")
        .send()
        .await
        .map_err(|_| "出口地址检查失败")?
        .error_for_status()
        .map_err(|_| "出口地址服务异常")?;
    let text = response.text().await.map_err(|_| "读取出口地址失败")?;
    let ip: std::net::IpAddr = text
        .trim()
        .parse()
        .map_err(|_| "出口地址服务返回无效数据")?;
    Ok(ip.to_string())
}

fn core_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位应用目录")?;
    let core = exe.parent().ok_or("无法定位应用目录")?.join("sing-box.exe");
    if !core.is_file() {
        return Err("应用目录缺少 sing-box.exe".into());
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
            config,
            port,
            mode: mode.unwrap_or_else(|| "local".into()),
            routing_mode: routing_mode.unwrap_or_default(),
            recover: auto_reconnect.unwrap_or(true),
            failover: auto_failover.unwrap_or(false),
            fallback_groups: fallback_groups.unwrap_or_default(),
        })
    })
    .await
    .map_err(|_| "启动代理任务异常".to_string())?
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
    if !state.live()?.is_some_and(|current| current.id == active.id) {
        return Ok(None);
    }
    snapshot.map(|snapshot| {
        Some(telemetry::SessionSnapshot {
            session_id: active.id,
            snapshot,
        })
    })
}
#[tauri::command]
async fn check_connection(port: u16, state: tauri::State<'_, ProxyState>) -> Result<u128, String> {
    if running_port(&state) != Some(port) {
        return Err("代理内核未运行".into());
    }
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
        .get("https://www.gstatic.com/generate_204")
        .send()
        .await
        .map_err(|_| "代理请求失败或超时，请检查节点和网络")?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
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
}

fn subscription_http_client(
    request: SubscriptionRequest,
    port: Option<u16>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let target = attempt.url();
            if attempt.previous().len() > 3
                || target.scheme() != "https"
                || !target.username().is_empty()
                || target.password().is_some()
            {
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
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("请输入不含账号密码的 HTTPS 订阅地址".into());
    }
    let request = request.unwrap_or_default();
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

fn main() {
    if let Some(code) = network::cli() {
        std::process::exit(code);
    }
    let _ = network::recover();
    let app = tauri::Builder::default()
        .manage(ProxyState::default())
        .manage(probes::ProbeBatch::default())
        .setup(|app| {
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            let show = MenuItem::with_id(app, "show", "打开 RelayDesk", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("RelayDesk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "stop" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let _ = app.state::<ProxyState>().stop();
                        });
                    }
                    "quit" => app.exit(0),
                    _ => (),
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
            let handle = app.handle().clone();
            std::thread::spawn(move || ProxyState::run(handle));
            tauri::async_runtime::spawn(ProxyState::watch_core_logs(app.handle().clone()));
            tauri::async_runtime::spawn(ProxyState::watch_nodes(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            fetch_subscription,
            allocate_port,
            validate_proxy_config,
            start_proxy,
            stop_proxy,
            proxy_status,
            proxy_events,
            configure_recovery,
            configure_failover,
            switch_proxy_node,
            set_routing_mode,
            proxy_telemetry,
            check_connection,
            check_website,
            probes::begin_probe_batch,
            probes::cancel_probe_batch,
            probes::probe_node,
            check_exit_ip,
            local_tcp_google,
            storage::save_subscription,
            storage::load_subscription
        ])
        .build(tauri::generate_context!())
        .expect("failed to build RelayDesk");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<ProxyState>();
            let _ = state.shutdown();
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
