#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    fs,
    io::Write,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;
mod network;
mod storage;
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

#[derive(Default)]
struct ProxyState(Mutex<Option<network::Session>>);

struct ProbeProcess(Child);
struct TemporaryConfig(PathBuf);
impl Drop for TemporaryConfig {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
impl Drop for ProbeProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
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
async fn probe_node(config: serde_json::Value, port: u16) -> Result<u64, String> {
    let inbound = config
        .get("inbounds")
        .and_then(|v| v.as_array())
        .and_then(|v| v.first())
        .ok_or("缺少本地入口")?;
    if inbound.get("listen").and_then(|v| v.as_str()) != Some("127.0.0.1")
        || inbound.get("type").and_then(|v| v.as_str()) != Some("mixed")
        || inbound.get("listen_port").and_then(|v| v.as_u64()) != Some(port as u64)
    {
        return Err("测速入口配置无效".into());
    }
    let path = std::env::temp_dir().join(format!("relaydesk-probe-{}.json", uuid::Uuid::new_v4()));
    fs::write(&path, serde_json::to_vec(&config).map_err(|_| "配置无效")?)
        .map_err(|_| "无法创建测速配置")?;
    let _temporary_config = TemporaryConfig(path.clone());
    let result = (|| -> Result<ProbeProcess, String> {
        let core = core_path()?;
        if !core_command(&core)
            .args(["check", "-c"])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "无法检查配置")?
            .success()
        {
            return Err("节点配置未通过内核检查".into());
        }
        let child = core_command(&core)
            .args(["run", "-c"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动测速内核")?;
        Ok(ProbeProcess(child))
    })();
    let mut process = result?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut ready = false;
    for _ in 0..50 {
        if process
            .0
            .try_wait()
            .map_err(|_| "无法检查测速内核")?
            .is_some()
        {
            return Err("测速内核启动失败".into());
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !ready {
        return Err("测速内核启动超时".into());
    }
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?)
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化测速")?;
    let started = std::time::Instant::now();
    let response = client
        .get("https://www.gstatic.com/generate_204")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "请求超时"
            } else if error.is_connect() {
                "建立代理连接或 TLS 握手失败"
            } else {
                "代理请求失败"
            }
        })?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("测速服务返回异常".into());
    }
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
async fn start_proxy(
    config: serde_json::Value,
    mode: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ProxyState>();
        let mut active = state.0.lock().map_err(|_| "代理状态不可用")?;
        if active.as_ref().is_some_and(network::Session::running) {
            return Err("代理已经运行".into());
        }
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
        *active = Some(network::Session::start(
            config,
            port,
            mode.as_deref().unwrap_or("local"),
        )?);
        Ok(())
    })
    .await
    .map_err(|_| "启动代理任务异常".to_string())?
}

#[tauri::command]
fn stop_proxy(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    stop_session(&state)
}

fn stop_session(state: &ProxyState) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|_| "代理状态不可用")?;
    active.take().map(network::Session::stop).unwrap_or(Ok(()))
}

fn running_port(state: &ProxyState) -> Option<u16> {
    state
        .0
        .lock()
        .ok()?
        .as_ref()
        .filter(|session| session.running())
        .map(|session| session.port)
}

#[tauri::command]
fn proxy_running(state: tauri::State<'_, ProxyState>) -> bool {
    running_port(&state).is_some()
}

#[tauri::command]
async fn proxy_telemetry(
    state: tauri::State<'_, ProxyState>,
) -> Result<Option<telemetry::SessionSnapshot>, String> {
    let controller = || {
        state
            .0
            .lock()
            .ok()?
            .as_ref()
            .filter(|session| session.running())
            .map(|session| (session.id.clone(), session.controller.clone()))
    };
    let Some((session_id, active)) = controller() else {
        return Ok(None);
    };
    let snapshot = active.snapshot().await;
    if !controller().is_some_and(|(current, _)| current == session_id) {
        return Ok(None);
    }
    snapshot.map(|snapshot| {
        Some(telemetry::SessionSnapshot {
            session_id,
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

#[tauri::command]
async fn fetch_subscription(address: String) -> Result<String, String> {
    let parsed = url::Url::parse(&address).map_err(|_| "订阅地址无效")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("请输入不含账号密码的 HTTPS 订阅地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化网络请求")?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "订阅请求失败，请检查网络")?
        .error_for_status()
        .map_err(|_| "订阅服务器返回错误状态")?;
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
    String::from_utf8(data).map_err(|_| "订阅内容不是 UTF-8 文本".into())
}

fn main() {
    if let Some(code) = network::cli() {
        std::process::exit(code);
    }
    let _ = network::recover();
    let app = tauri::Builder::default()
        .manage(ProxyState::default())
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
                        let state = app.state::<ProxyState>();
                        let _ = stop_session(&state);
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
            start_proxy,
            stop_proxy,
            proxy_running,
            proxy_telemetry,
            check_connection,
            probe_node,
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
            let _ = stop_session(&state);
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
