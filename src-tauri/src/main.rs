#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{fs, io::Write, net::{TcpListener, TcpStream}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::Manager;

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
struct ProxyState(Mutex<Option<Child>>);

struct ProbeProcess(Child);
struct TemporaryConfig(PathBuf);
impl Drop for TemporaryConfig {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}
impl Drop for ProbeProcess {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[tauri::command]
async fn probe_node(config: serde_json::Value, port: u16) -> Result<u64, String> {
    let inbound = config.get("inbounds").and_then(|v| v.as_array()).and_then(|v| v.first()).ok_or("缺少本地入口")?;
    if inbound.get("listen").and_then(|v| v.as_str()) != Some("127.0.0.1") || inbound.get("type").and_then(|v| v.as_str()) != Some("mixed") || inbound.get("listen_port").and_then(|v| v.as_u64()) != Some(port as u64) { return Err("测速入口配置无效".into()); }
    let path = std::env::temp_dir().join(format!("relaydesk-probe-{}.json", uuid::Uuid::new_v4()));
    fs::write(&path, serde_json::to_vec(&config).map_err(|_| "配置无效")?).map_err(|_| "无法创建测速配置")?;
    let _temporary_config = TemporaryConfig(path.clone());
    let result = (|| -> Result<ProbeProcess, String> {
        let core = core_path()?;
        if !core_command(&core).args(["check", "-c"]).arg(&path).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "无法检查配置")?.success() { return Err("节点配置未通过内核检查".into()); }
        let child = core_command(&core).args(["run", "-c"]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "无法启动测速内核")?;
        Ok(ProbeProcess(child))
    })();
    let mut process = result?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut ready = false;
    for _ in 0..50 {
        if process.0.try_wait().map_err(|_| "无法检查测速内核")?.is_some() { return Err("测速内核启动失败".into()); }
        if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() { ready = true; break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !ready { return Err("测速内核启动超时".into()); }
    let client = reqwest::Client::builder().proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?).timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法初始化测速")?;
    let started = std::time::Instant::now();
    let response = client.get("https://www.gstatic.com/generate_204").send().await.map_err(|_| "连接失败或超时")?;
    if response.status() != reqwest::StatusCode::NO_CONTENT { return Err("测速服务返回异常".into()); }
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
async fn check_exit_ip(port: u16, state: tauri::State<'_, ProxyState>) -> Result<String, String> {
    if !proxy_running(state) { return Err("代理内核未运行".into()); }
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder().proxy(proxy).timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法初始化出口检查")?;
    let response = client.get("https://api.ipify.org").send().await.map_err(|_| "出口地址检查失败")?.error_for_status().map_err(|_| "出口地址服务异常")?;
    let text = response.text().await.map_err(|_| "读取出口地址失败")?;
    let ip: std::net::IpAddr = text.trim().parse().map_err(|_| "出口地址服务返回无效数据")?;
    Ok(ip.to_string())
}

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
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "无法创建临时配置")?;
        file.write_all(serde_json::to_string(&config).map_err(|_| "配置无效")?.as_bytes()).map_err(|_| "无法写入配置")?;
        drop(file);
        let core = core_path()?;
        let check = core_command(&core).args(["check", "-c"]).arg(&path).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "无法启动内核检查")?;
        if !check.success() { return Err("节点配置未通过内核检查".into()); }
        let mut process = core_command(&core).args(["run", "-c"]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "无法启动内核")?;
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        for _ in 0..50 {
            if process.try_wait().map_err(|_| "无法检查内核进程")?.is_some() { return Err("内核启动失败".into()) }
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
async fn check_connection(port: u16, state: tauri::State<'_, ProxyState>) -> Result<u128, String> {
    if !proxy_running(state) { return Err("代理内核未运行".into()); }
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|_| "本地代理地址无效")?;
    let client = reqwest::Client::builder().proxy(proxy).timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法启动连接检查")?;
    let started = std::time::Instant::now();
    let response = client.get("https://www.gstatic.com/generate_204").send().await
        .map_err(|_| "代理请求失败或超时，请检查节点和网络")?;
    if response.status() != reqwest::StatusCode::NO_CONTENT { return Err("检查地址返回异常状态，连接未确认".into()); }
    Ok(started.elapsed().as_millis())
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
        .invoke_handler(tauri::generate_handler![fetch_subscription, allocate_port, start_proxy, stop_proxy, proxy_running, check_connection, probe_node, check_exit_ip])
        .build(tauri::generate_context!()).expect("failed to build RelayDesk");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<ProxyState>();
            if let Ok(mut child) = state.0.lock() { if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); } };
        }
    });
}
