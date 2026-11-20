use crate::{core_command, core_path, system_proxy};
use serde_json::{json, Value};
use std::{
    env, fs,
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    ptr, thread,
    time::{Duration, Instant},
};
use std::{
    net::{SocketAddr, TcpStream},
    os::windows::io::AsRawHandle,
    process::{Child, Stdio},
};
use winapi::{
    shared::minwindef::{FALSE, TRUE},
    um::{
        handleapi::CloseHandle,
        jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
        processthreadsapi::OpenProcess,
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
        let name = wide("Local\\RelayDesk.Network");
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
    system_proxy::recover(&runtime_dir()?.join("proxy.json"))
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

// The elevated worker accepts only the fields our own compiler emits. Inbound,
// DNS, interface and route behavior are constructed locally, not supplied by IPC.
fn tun_config(config: &Value, port: u16) -> Option<Value> {
    let root = checked_object(config, &["log", "inbounds", "outbounds", "route"])?;
    let outbounds = root.get("outbounds")?.as_array()?;
    let [node, direct] = outbounds.as_slice() else {
        return None;
    };
    if *direct != json!({"type":"direct","tag":"direct"}) {
        return None;
    }
    let node = checked_object(
        node,
        &[
            "type",
            "tag",
            "server",
            "server_port",
            "server_ports",
            "uuid",
            "flow",
            "password",
            "tls",
            "transport",
        ],
    )?;
    if !matches!(node.get("type")?.as_str(), Some("vless" | "hysteria2"))
        || node.get("tag")?.as_str()? != "proxy"
    {
        return None;
    }
    if node.iter().any(|(key, value)| match key.as_str() {
        "tls" | "transport" => false,
        "server_port" => !value.is_u64(),
        "server_ports" => !value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string)),
        _ => !value.is_string(),
    }) {
        return None;
    }
    if let Some(tls) = node.get("tls") {
        let tls = checked_object(
            tls,
            &[
                "enabled",
                "server_name",
                "insecure",
                "alpn",
                "utls",
                "reality",
            ],
        )?;
        for (key, value) in tls {
            match key.as_str() {
                "enabled" | "insecure" if value.is_boolean() => (),
                "server_name" if value.is_string() => (),
                "alpn"
                    if value
                        .as_array()
                        .is_some_and(|items| items.iter().all(Value::is_string)) =>
                {
                    ()
                }
                "utls"
                    if checked_object(value, &["enabled", "fingerprint"])
                        .is_some_and(|m| m.values().all(|v| v.is_string() || v.is_boolean())) =>
                {
                    ()
                }
                "reality"
                    if checked_object(value, &["enabled", "public_key", "short_id"])
                        .is_some_and(|m| m.values().all(|v| v.is_string() || v.is_boolean())) =>
                {
                    ()
                }
                _ => return None,
            }
        }
    }
    if let Some(transport) = node.get("transport") {
        let transport = checked_object(transport, &["type", "path", "service_name", "headers"])?;
        if !matches!(transport.get("type")?.as_str(), Some("ws" | "grpc")) {
            return None;
        }
        if transport.iter().any(|(key, value)| {
            if key == "headers" {
                !checked_object(value, &["Host"]).is_some_and(|m| m.values().all(Value::is_string))
            } else {
                !value.is_string()
            }
        }) {
            return None;
        }
    }
    let route = checked_object(
        root.get("route")?,
        &["rules", "final", "auto_detect_interface"],
    )?;
    let rules = route.get("rules")?.as_array()?;
    let mut output_rules = vec![
        json!({"action":"sniff"}),
        json!({"protocol":"dns","action":"hijack-dns"}),
    ];
    for rule in rules {
        let fields = checked_object(rule, &["domain", "domain_suffix", "outbound", "action"])?;
        let destination = fields
            .get("domain")
            .or_else(|| fields.get("domain_suffix"))?
            .as_array()?;
        if !destination.iter().all(Value::is_string) {
            return None;
        }
        match (fields.get("action"), fields.get("outbound")) {
            (Some(action), None) if action.as_str() == Some("reject") => (),
            (None, Some(outbound)) if matches!(outbound.as_str(), Some("direct" | "proxy")) => (),
            _ => return None,
        }
        output_rules.push(rule.clone());
    }
    Some(json!({
        "log": {"level":"warn"},
        "inbounds": [
            {"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port},
            {"type":"tun","tag":"tun","interface_name":"RelayDesk","address":["172.28.254.1/30","fdfe:dcba:9876::1/126"],"auto_route":true,"strict_route":true,"stack":"mixed"}
        ],
        "outbounds": outbounds,
        "route":{"rules":output_rules,"final":"proxy","auto_detect_interface":true,"default_domain_resolver":"bootstrap"},
        "dns":{
            "servers":[{"type":"local","tag":"bootstrap"},{"type":"https","tag":"remote","server":"1.1.1.1","path":"/dns-query","detour":"proxy"}],
            "final":"remote"
        }
    }))
}

pub struct Session {
    worker: Handle,
    stop: Handle,
    pub port: u16,
}

impl Session {
    pub fn start(config: Value, port: u16, mode: &str) -> Result<Self, String> {
        if !matches!(mode, "local" | "system" | "tun") {
            return Err("代理入口模式无效".into());
        }
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
        fs::write(
            &path,
            serde_json::to_vec(&config).map_err(|_| "代理配置无效")?,
        )
        .map_err(|_| "无法写入代理配置")?;
        let executable = wide(
            env::current_exe()
                .map_err(|_| "无法定位当前应用")?
                .as_os_str(),
        );
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
        };
        let deadline = Instant::now() + APPLY_TIMEOUT;
        while Instant::now() < deadline {
            if ready.signaled(40) && session.running() {
                return Ok(session);
            }
            if !session.running() {
                break;
            }
        }
        Err(if mode == "tun" {
            "TUN 启动失败，请检查管理员权限、虚拟网卡或 DNS 配置"
        } else {
            "代理启动失败，请检查内核、端口或 Windows 代理设置"
        }
        .into())
    }

    pub fn running(&self) -> bool {
        !self.worker.signaled(0)
    }

    pub fn stop(self) -> Result<(), String> {
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

fn run_worker(args: &[String]) -> Result<(), String> {
    let [parent, token, port, mode] = args else {
        return Err("网络参数无效".into());
    };
    let parent: u32 = parent.parse().map_err(|_| "父进程无效")?;
    let port: u16 = port.parse().map_err(|_| "端口无效")?;
    if token.len() != 32
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
        || port < 1024
        || !matches!(mode.as_str(), "local" | "system" | "tun")
    {
        return Err("网络参数无效".into());
    }
    let parent = Handle::new(unsafe { OpenProcess(SYNCHRONIZE, FALSE, parent) })?;
    let stop =
        Handle::new(unsafe { OpenEventW(SYNCHRONIZE, FALSE, event_name(token, "stop").as_ptr()) })?;
    let ready = Handle::new(unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE,
            FALSE,
            event_name(token, "ready").as_ptr(),
        )
    })?;
    let _lock = NetworkLock::acquire()?;
    let directory = runtime_dir()?;
    let journal = directory.join("proxy.json");
    system_proxy::recover(&journal).map_err(|_| "恢复系统代理失败")?;
    let input = directory.join(format!("{token}.json"));
    let config = fs::read(input).map_err(|_| "无法读取内核配置")?;
    let mut config: Value = serde_json::from_slice(&config).map_err(|_| "内核配置无效")?;
    if mode == "tun" {
        config = tun_config(&config, port).ok_or("TUN 配置无效")?;
    }
    let core = core_path()?;
    let config = serde_json::to_vec(&config).map_err(|_| "内核配置无效")?;
    let job = job()?;
    let config_command = |action| {
        let mut command = core_command(&core);
        command
            .args([action, "-c", "stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    };
    let mut check = config_command("check")
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
        || !check.wait().map_err(|_| "无法完成内核检查")?.success()
    {
        return Err("内核配置检查失败".into());
    }
    let mut child = config_command("run")
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
    let deadline = Instant::now() + Duration::from_secs(9);
    loop {
        if stop.signaled(0)
            || parent.signaled(0)
            || child
                .try_wait()
                .map_err(|_| "无法读取内核进程状态")?
                .is_some()
            || Instant::now() >= deadline
        {
            return Err("本地代理入口未就绪".into());
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(80)).is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(70));
    }
    if mode == "system" {
        system_proxy::enable(&journal, port).map_err(|_| "无法设置系统代理")?;
    }
    unsafe {
        SetEvent(ready.0);
    }
    while !stop.signaled(150) && !parent.signaled(0) && matches!(child.try_wait(), Ok(None)) {}
    let restored = system_proxy::recover(&journal);
    let _ = child.kill();
    let _ = child.wait();
    restored.map_err(|_| "无法恢复系统代理".into())
}

pub fn cli() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--network-worker") => Some(if run_worker(&args[1..]).is_ok() { 0 } else { 1 }),
        Some("--recover-network") => Some(if recover().is_ok() { 0 } else { 1 }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elevated_worker_rejects_unexpected_fields() {
        let mut config = json!({
            "outbounds": [{"type":"vless","tag":"proxy","server":"example.com","server_port":443,"uuid":"00000000-0000-4000-8000-000000000000"},{"type":"direct","tag":"direct"}],
            "route": {"rules":[]}
        });
        assert!(tun_config(&config, 17771).is_some());
        config["outbounds"][0]["tls"] = json!({"enabled":true,"certificate_path":"sensitive"});
        assert!(tun_config(&config, 17771).is_none());
    }
}
