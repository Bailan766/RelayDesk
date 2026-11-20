#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{fs, io::Write, net::{TcpListener, TcpStream}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::Manager;

#[derive(Default)]
struct ProxyState(Mutex<Option<Child>>);

fn core_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位应用目录")?;
    let core = exe.parent().ok_or("无法定位应用目录")?.join("sing-box.exe");
    if !core.is_file() { return Err("应用目录缺少 sing-box.exe".into()); }
    Ok(core)
}

#[tauri::command]
fn allocate_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr()).map(|addr| addr.port()).map_err(|_| "无法分配本地端口".into())
}

#[tauri::command]
fn start_proxy(config: serde_json::Value, state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|_| "代理状态不可用")?;
    if let Some(existing) = child.as_mut() {
        if existing.try_wait().map_err(|_| "无法检查内核状态")?.is_none() { return Err("代理已经运行".into()); }
    }
    let inbound = config.get("inbounds").and_then(|x| x.as_array()).and_then(|x| x.first()).ok_or("缺少本地入口")?;
    let port = inbound.get("listen_port").and_then(|v| v.as_u64()).filter(|v| (1024..=65535).contains(v)).ok_or("本地端口无效")? as u16;
    if inbound.get("listen").and_then(|x| x.as_str()) != Some("127.0.0.1") || inbound.get("type").and_then(|x| x.as_str()) != Some("mixed") { return Err("本地入口配置无效".into()); }
    let path = std::env::temp_dir().join(format!("relaydesk-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "无法创建临时配置")?;
        file.write_all(serde_json::to_string(&config).map_err(|_| "配置无效")?.as_bytes()).map_err(|_| "无法写入配置")?;
        drop(file);
        let core = core_path()?;
        let check = Command::new(&core).args(["check", "-c"]).arg(&path).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "无法启动内核检查")?;
        if !check.success() { return Err("节点配置未通过内核检查".into()); }
        let mut process = Command::new(core).args(["run", "-c"]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "无法启动内核")?;
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        for _ in 0..50 {
            if process.try_wait().map_err(|_| "无法检查内核进程")?.is_some() { return Err("内核启动失败") }
            if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() { *child = Some(process); return Ok(()) }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = process.kill(); let _ = process.wait(); Err("内核启动超时".into())
    })();
    let _ = fs::remove_file(path);
    result
}

#[tauri::command]
fn stop_proxy(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|_| "代理状态不可用")?;
    if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); }
    Ok(())
}

#[tauri::command]
fn proxy_running(state: tauri::State<'_, ProxyState>) -> bool {
    state.0.lock().ok().and_then(|mut child| child.as_mut().map(|p| matches!(p.try_wait(), Ok(None)))).unwrap_or(false)
}

#[tauri::command]
async fn fetch_subscription(address: String) -> Result<String, String> {
    let parsed = url::Url::parse(&address).map_err(|_| "订阅地址无效")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("请输入不含账号密码的 HTTPS 订阅地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "无法初始化网络请求")?;
    let mut response = client.get(parsed).send().await.map_err(|_| "订阅请求失败，请检查网络")?
        .error_for_status().map_err(|_| "订阅服务器返回错误状态")?;
    const LIMIT: usize = 4 * 1024 * 1024;
    if response.content_length().is_some_and(|length| length > LIMIT as u64) {
        return Err("订阅内容超过 4 MB".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取订阅失败")? {
        if data.len() + chunk.len() > LIMIT { return Err("订阅内容超过 4 MB".into()); }
        data.extend_from_slice(&chunk);
    }
    String::from_utf8(data).map_err(|_| "订阅内容不是 UTF-8 文本".into())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ProxyState::default())
        .invoke_handler(tauri::generate_handler![fetch_subscription, allocate_port, start_proxy, stop_proxy, proxy_running])
        .build(tauri::generate_context!()).expect("failed to build RelayDesk");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<ProxyState>();
            if let Ok(mut child) = state.0.lock() { if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); } }
        }
    });
}
