use crate::network::{CoreSettings, RoutingMode, Session, SessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use winapi::{
    shared::{
        minwindef::{DWORD, FALSE},
        sddl::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        winerror::{ERROR_BROKEN_PIPE, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED},
    },
    um::{
        errhandlingapi::GetLastError,
        handleapi::INVALID_HANDLE_VALUE,
        minwinbase::SECURITY_ATTRIBUTES,
        namedpipeapi::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, WaitNamedPipeW,
        },
        processthreadsapi::GetExitCodeProcess,
        shellapi::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        synchapi::WaitForSingleObject,
        winbase::{
            LocalFree, PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_BYTE, PIPE_WAIT,
        },
        winnt::{
            HANDLE, PSECURITY_DESCRIPTOR, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
            SERVICE_WIN32_OWN_PROCESS,
        },
        winsvc::{
            ControlService, CreateServiceW, DeleteService, OpenSCManagerW, OpenServiceW,
            QueryServiceStatus, RegisterServiceCtrlHandlerW, SetServiceStatus,
            StartServiceCtrlDispatcherW, StartServiceW, SC_HANDLE, SC_MANAGER_ALL_ACCESS,
            SC_MANAGER_CONNECT, SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP,
            SERVICE_ALL_ACCESS, SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_SHUTDOWN,
            SERVICE_CONTROL_STOP, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START_PENDING,
            SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_STOPPED, SERVICE_STOP_PENDING,
            SERVICE_TABLE_ENTRYW,
        },
    },
};

const SERVICE_NAME: &str = "RelayDeskTunService";
const SERVICE_DISPLAY_NAME: &str = "RelayDesk TUN Service";
const PIPE_NAME: &str = r"\\.\pipe\RelayDesk.TunService.v1";
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");

static SERVICE_PROCESS: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static STATUS_HANDLE: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_SESSIONS: AtomicU32 = AtomicU32::new(0);
static TUN_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusInfo {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub up_to_date: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum PipeCommand {
    Status,
    Start {
        settings: CoreSettings,
        port: u16,
        routing_mode: RoutingMode,
        recover: bool,
        options: SessionOptions,
    },
    SyncRouting {
        routing_mode: RoutingMode,
        config: Value,
    },
    SyncMihomo {
        config: Value,
        selections: BTreeMap<String, String>,
    },
    SetRecovery {
        enabled: bool,
    },
    Stop,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(crate) enum PipeEvent {
    Status {
        version: String,
        busy: bool,
    },
    Ready {
        id: String,
        port: u16,
        controller: crate::telemetry::Controller,
        tun_interface: Option<String>,
        tun_ipv6: bool,
        allow_lan: bool,
    },
    State {
        running: bool,
        recovering: bool,
        generation: u32,
        #[serde(default)]
        tun_interface: Option<String>,
    },
    Error {
        message: String,
    },
    Stopped,
}

#[derive(Default)]
pub struct ServiceRuntimeState {
    pub running: AtomicBool,
    pub recovering: AtomicBool,
    pub generation: AtomicU32,
    pub tun_interface: Mutex<Option<String>>,
}

pub struct ServiceSession {
    pub pipe: Mutex<File>,
    pub state: Arc<ServiceRuntimeState>,
    pub port: u16,
    pub controller: crate::telemetry::Controller,
    pub id: String,
    pub tun_ipv6: bool,
    pub allow_lan: bool,
}

impl ServiceSession {
    pub fn active_tun_interface(&self) -> Option<String> {
        self.state.tun_interface.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn send_command(&self, command: &PipeCommand) -> Result<(), String> {
        let mut line = serde_json::to_vec(command).map_err(|_| "服务指令编码失败")?;
        line.push(b'\n');
        let mut pipe = self.pipe.lock().map_err(|_| "服务通道已锁定")?;
        pipe.write_all(&line).map_err(|_| "发送服务控制指令失败")?;
        let _ = pipe.flush();
        Ok(())
    }

    pub fn stop(self) -> Result<(), String> {
        let _ = self.send_command(&PipeCommand::Stop);
        let deadline = Instant::now() + Duration::from_secs(6);
        while self.state.running.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}

impl Drop for ServiceSession {
    fn drop(&mut self) {
        self.state.running.store(false, Ordering::Release);
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                winapi::um::winsvc::CloseServiceHandle(self.0);
            }
        }
    }
}

struct LocalSd(PSECURITY_DESCRIPTOR);

impl Drop for LocalSd {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0.cast());
            }
        }
    }
}

pub fn is_service_process() -> bool {
    SERVICE_PROCESS.load(Ordering::Acquire)
}

fn service_dir() -> Result<PathBuf, String> {
    let base = env::var_os("ProgramData").ok_or("无法定位系统 ProgramData 目录")?;
    Ok(PathBuf::from(base).join("RelayDesk").join("service"))
}

fn open_pipe_client() -> Result<File, std::io::Error> {
    let deadline = Instant::now() + Duration::from_millis(900);
    loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(0)
            .open(PIPE_NAME)
        {
            Ok(file) => return Ok(file),
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && Instant::now() < deadline =>
            {
                let name = wide(PIPE_NAME);
                unsafe {
                    WaitNamedPipeW(name.as_ptr(), 250);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn send_line(writer: &mut File, event: &PipeEvent) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(event).map_err(|_| "序列化服务状态失败")?;
    bytes.push(b'\n');
    writer.write_all(&bytes).map_err(|_| "写入管道失败")?;
    let _ = writer.flush();
    Ok(())
}

pub fn query_status() -> ServiceStatusInfo {
    let mut info = ServiceStatusInfo {
        installed: false,
        running: false,
        version: None,
        up_to_date: false,
    };
    let Ok(scm) = (unsafe {
        let h = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT);
        if h.is_null() {
            Err(())
        } else {
            Ok(ScHandle(h))
        }
    }) else {
        return info;
    };
    let name = wide(SERVICE_NAME);
    let service = unsafe { OpenServiceW(scm.0, name.as_ptr(), SERVICE_QUERY_STATUS) };
    if service.is_null() {
        return info;
    }
    let service = ScHandle(service);
    info.installed = true;
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
        return info;
    }
    info.running = status.dwCurrentState == SERVICE_RUNNING;
    if info.running {
        if let Ok(mut pipe) = open_pipe_client() {
            let mut cmd = serde_json::to_vec(&PipeCommand::Status).unwrap_or_default();
            cmd.push(b'\n');
            if pipe.write_all(&cmd).is_ok() {
                let mut reader = BufReader::new(pipe);
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    if let Ok(PipeEvent::Status { version, .. }) =
                        serde_json::from_str::<PipeEvent>(line.trim())
                    {
                        info.up_to_date = version == SERVICE_VERSION;
                        info.version = Some(version);
                    }
                }
            }
        }
    }
    info
}

pub(crate) fn try_start_tun(
    settings: &CoreSettings,
    port: u16,
    routing_mode: RoutingMode,
    recover: bool,
    options: &SessionOptions,
) -> Option<Result<ServiceSession, String>> {
    if is_service_process() {
        return None;
    }
    let status = query_status();
    if !status.installed || !status.running || !status.up_to_date {
        return None;
    }
    let mut pipe = match open_pipe_client() {
        Ok(pipe) => pipe,
        Err(_) => return None,
    };
    let command = PipeCommand::Start {
        settings: settings.clone(),
        port,
        routing_mode,
        recover,
        options: options.clone(),
    };
    let mut bytes = match serde_json::to_vec(&command) {
        Ok(bytes) => bytes,
        Err(_) => return Some(Err("服务启动请求无效".into())),
    };
    bytes.push(b'\n');
    if pipe.write_all(&bytes).is_err() || pipe.flush().is_err() {
        return Some(Err("无法向后台服务发送 TUN 启动请求".into()));
    }
    let mut read_pipe = match pipe.try_clone() {
        Ok(clone) => clone,
        Err(_) => return Some(Err("无法克隆后台服务通信句柄".into())),
    };
    let mut initial_pending: Vec<u8> = Vec::new();
    let ready_deadline = Instant::now() + Duration::from_secs(45);
    let mut ready_line = None;
    let read_raw = read_pipe.as_raw_handle() as HANDLE;
    while Instant::now() < ready_deadline {
        if let Some(pos) = initial_pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = initial_pending.drain(..=pos).collect();
            ready_line = Some(String::from_utf8_lossy(&raw).into_owned());
            break;
        }
        let mut avail = 0u32;
        if unsafe {
            PeekNamedPipe(
                read_raw,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut avail,
                ptr::null_mut(),
            )
        } == 0
        {
            break;
        }
        if avail > 0 {
            let mut chunk = vec![0u8; (avail as usize).min(65536)];
            match read_pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => initial_pending.extend_from_slice(&chunk[..n]),
            }
            continue;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let Some(line) = ready_line else {
        return Some(Err("后台服务未响应 TUN 启动请求".into()));
    };
    let event = match serde_json::from_str::<PipeEvent>(line.trim()) {
        Ok(event) => event,
        Err(_) => return Some(Err("后台服务返回无效响应".into())),
    };
    let (id, ready_port, controller, tun_interface, tun_ipv6, allow_lan) = match event {
        PipeEvent::Ready {
            id,
            port,
            controller,
            tun_interface,
            tun_ipv6,
            allow_lan,
        } => (id, port, controller, tun_interface, tun_ipv6, allow_lan),
        PipeEvent::Error { message } => return Some(Err(message)),
        _ => return Some(Err("后台服务返回未预期的启动状态".into())),
    };
    let state = Arc::new(ServiceRuntimeState {
        running: AtomicBool::new(true),
        recovering: AtomicBool::new(false),
        generation: AtomicU32::new(0),
        tun_interface: Mutex::new(tun_interface),
    });
    let state_reader = Arc::clone(&state);
    thread::spawn(move || {
        let mut pending = initial_pending;
        let raw = read_pipe.as_raw_handle() as HANDLE;
        while state_reader.running.load(Ordering::Acquire) {
            let mut avail = 0u32;
            if unsafe {
                PeekNamedPipe(
                    raw,
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    &mut avail,
                    ptr::null_mut(),
                )
            } == 0
            {
                break;
            }
            if avail > 0 {
                let mut chunk = vec![0u8; (avail as usize).min(65536)];
                match read_pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&chunk[..n]);
                        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                            let line_raw: Vec<u8> = pending.drain(..=pos).collect();
                            let line = String::from_utf8_lossy(&line_raw);
                            match serde_json::from_str::<PipeEvent>(line.trim()) {
                                Ok(PipeEvent::State {
                                    running,
                                    recovering,
                                    generation,
                                    tun_interface,
                                }) => {
                                    state_reader.running.store(running, Ordering::Release);
                                    state_reader.recovering.store(recovering, Ordering::Release);
                                    state_reader.generation.store(generation, Ordering::Release);
                                    if let Some(iface) = tun_interface {
                                        if let Ok(mut guard) = state_reader.tun_interface.lock() {
                                            *guard = Some(iface);
                                        }
                                    }
                                    if !running {
                                        return;
                                    }
                                }
                                Ok(PipeEvent::Stopped) => {
                                    state_reader.running.store(false, Ordering::Release);
                                    state_reader.recovering.store(false, Ordering::Release);
                                    return;
                                }
                                _ => {}
                            }
                        }
                    }
                }
                continue;
            }
            thread::sleep(Duration::from_millis(50));
        }
        state_reader.running.store(false, Ordering::Release);
        state_reader.recovering.store(false, Ordering::Release);
    });
    Some(Ok(ServiceSession {
        pipe: Mutex::new(pipe),
        state,
        port: ready_port,
        controller,
        id,
        tun_ipv6,
        allow_lan,
    }))
}

fn stop_and_delete_existing(scm: SC_HANDLE) -> Result<(), String> {
    let name = wide(SERVICE_NAME);
    let handle = unsafe { OpenServiceW(scm, name.as_ptr(), SERVICE_ALL_ACCESS) };
    if handle.is_null() {
        return Ok(());
    }
    let handle = ScHandle(handle);
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { QueryServiceStatus(handle.0, &mut status) } != 0
        && status.dwCurrentState != SERVICE_STOPPED
    {
        unsafe {
            ControlService(handle.0, SERVICE_CONTROL_STOP, &mut status);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(150));
            if unsafe { QueryServiceStatus(handle.0, &mut status) } != 0
                && status.dwCurrentState == SERVICE_STOPPED
            {
                break;
            }
        }
    }
    if unsafe { DeleteService(handle.0) } == 0 {
        let err = unsafe { GetLastError() };
        // ERROR_SERVICE_MARKED_FOR_DELETE = 1072
        if err != 1072 {
            return Err("无法注销旧版 RelayDesk 后台服务".into());
        }
    }
    drop(handle);
    thread::sleep(Duration::from_millis(350));
    Ok(())
}

fn lock_service_directory(dir: &Path) -> Result<(), String> {
    let status = crate::core_command(Path::new("icacls"))
        .arg(dir)
        .args([
            "/inheritance:r",
            "/T",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "/grant:r",
            "*S-1-5-32-544:(OI)(CI)F",
            "/grant:r",
            "*S-1-5-11:(OI)(CI)RX",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "无法配置后台服务目录权限")?;
    if !status.success() {
        return Err("后台服务目录权限加固失败".into());
    }
    Ok(())
}

pub fn install_current() -> Result<(), String> {
    if !crate::network::is_elevated() {
        return Err("安装后台服务需要管理员权限".into());
    }
    let current_exe = env::current_exe().map_err(|_| "无法定位当前应用程序")?;
    let source_dir = current_exe.parent().ok_or("无法定位应用安装目录")?;
    let target_dir = service_dir()?;

    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
    if scm.is_null() {
        return Err("无法打开 Windows 服务管理器".into());
    }
    let scm = ScHandle(scm);
    stop_and_delete_existing(scm.0)?;

    fs::create_dir_all(&target_dir).map_err(|_| "无法创建后台服务目录")?;
    let exe_dest = target_dir.join("relaydesk-service.exe");
    fs::copy(&current_exe, &exe_dest).map_err(|_| "无法复制服务程序文件（请先停止使用服务的代理后重试）")?;
    for required in ["sing-box.exe", "mihomo.exe", "wintun.dll"] {
        let src = source_dir.join(required);
        if !src.is_file() {
            return Err(format!("应用目录缺少 {required}"));
        }
        fs::copy(&src, target_dir.join(required))
            .map_err(|_| format!("无法复制内核 {required} 至服务目录"))?;
    }
    for optional in ["Country.mmdb", "geoip.metadb"] {
        let src = source_dir.join(optional);
        if src.is_file() {
            let _ = fs::copy(&src, target_dir.join(optional));
        }
    }
    lock_service_directory(&target_dir)?;

    let name = wide(SERVICE_NAME);
    let display = wide(SERVICE_DISPLAY_NAME);
    let bin_path = wide(&format!("\"{}\" --tun-service", exe_dest.display()));
    let service = unsafe {
        CreateServiceW(
            scm.0,
            name.as_ptr(),
            display.as_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            bin_path.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
        )
    };
    if service.is_null() {
        return Err("注册 Windows 后台服务失败".into());
    }
    let service = ScHandle(service);
    if unsafe { StartServiceW(service.0, 0, ptr::null_mut()) } == 0 {
        return Err("后台服务注册成功，但启动失败".into());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    while Instant::now() < deadline {
        if unsafe { QueryServiceStatus(service.0, &mut status) } != 0
            && status.dwCurrentState == SERVICE_RUNNING
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("后台服务启动超时".into())
}

pub fn uninstall() -> Result<(), String> {
    if !crate::network::is_elevated() {
        return Err("卸载后台服务需要管理员权限".into());
    }
    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
    if scm.is_null() {
        return Err("无法打开 Windows 服务管理器".into());
    }
    let scm = ScHandle(scm);
    stop_and_delete_existing(scm.0)?;
    if let Ok(dir) = service_dir() {
        let _ = fs::remove_dir_all(dir);
    }
    Ok(())
}

fn run_elevated_flag(flag: &str, fail_msg: &str) -> Result<(), String> {
    if crate::network::is_elevated() {
        return match flag {
            "--install-service" => install_current(),
            "--uninstall-service" => uninstall(),
            _ => Err("不支持的服务参数".into()),
        };
    }
    let exe = env::current_exe().map_err(|_| "无法定位当前程序")?;
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    let verb = wide("runas");
    let params = wide(flag);
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = 0;
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
        return Err("未获得管理员权限授权".into());
    }
    let wait = unsafe { WaitForSingleObject(info.hProcess, 35_000) };
    let mut code = 1u32;
    let got_code = unsafe { GetExitCodeProcess(info.hProcess, &mut code) } != 0;
    unsafe {
        winapi::um::handleapi::CloseHandle(info.hProcess);
    }
    if wait == 0 && got_code && code == 0 {
        return Ok(());
    }
    Err(fail_msg.into())
}

pub fn install_elevated() -> Result<(), String> {
    run_elevated_flag("--install-service", "安装后台服务未成功完成")
}

pub fn uninstall_elevated() -> Result<(), String> {
    run_elevated_flag("--uninstall-service", "卸载后台服务未成功完成")
}

fn report_status(state: DWORD, wait_hint: DWORD, exit_code: DWORD) {
    let raw = STATUS_HANDLE.load(Ordering::Acquire);
    if raw == 0 {
        return;
    }
    let mut status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: exit_code,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: wait_hint,
    };
    unsafe {
        SetServiceStatus(raw as SERVICE_STATUS_HANDLE, &mut status);
    }
}

unsafe extern "system" fn ctrl_handler(control: DWORD) {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            STOP_REQUESTED.store(true, Ordering::Release);
            report_status(SERVICE_STOP_PENDING, 4000, 0);
            thread::spawn(|| {
                let _ = OpenOptions::new().read(true).write(true).open(PIPE_NAME);
            });
        }
        SERVICE_CONTROL_INTERROGATE => {
            let state = if STOP_REQUESTED.load(Ordering::Acquire) {
                SERVICE_STOP_PENDING
            } else {
                SERVICE_RUNNING
            };
            report_status(state, 0, 0);
        }
        _ => {}
    }
}

fn create_pipe_instance() -> Result<File, String> {
    let sddl = wide("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)");
    let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("无法构建服务管道安全描述符".into());
    }
    let _sd_guard = LocalSd(sd);
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: FALSE,
    };
    let name = wide(PIPE_NAME);
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            8,
            65536,
            65536,
            5000,
            &mut sa,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("创建后台服务命名管道失败".into());
    }
    Ok(unsafe { File::from(OwnedHandle::from_raw_handle(handle as RawHandle)) })
}

fn handle_pipe_client(mut pipe: File) {
    let mut reader_pipe = match pipe.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut read_next_line = |timeout: Duration| -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                let raw: Vec<u8> = pending.drain(..=pos).collect();
                return Some(String::from_utf8_lossy(&raw).into_owned());
            }
            if pending.len() > 16 * 1024 * 1024 {
                return None;
            }
            let mut avail = 0u32;
            let raw = reader_pipe.as_raw_handle() as HANDLE;
            if unsafe {
                PeekNamedPipe(
                    raw,
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    &mut avail,
                    ptr::null_mut(),
                )
            } == 0
            {
                return None;
            }
            if avail > 0 {
                let mut buf = vec![0u8; (avail as usize).min(65536)];
                match reader_pipe.read(&mut buf) {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => pending.extend_from_slice(&buf[..n]),
                }
                continue;
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    };
    let Some(first_line) = read_next_line(Duration::from_secs(5)) else {
        return;
    };
    let cmd = match serde_json::from_str::<PipeCommand>(first_line.trim()) {
        Ok(cmd) => cmd,
        Err(_) => {
            let _ = send_line(
                &mut pipe,
                &PipeEvent::Error {
                    message: "无效的服务命令".into(),
                },
            );
            return;
        }
    };
    let mutex = TUN_MUTEX.get_or_init(|| Mutex::new(()));
    match cmd {
        PipeCommand::Status => {
            let busy = ACTIVE_SESSIONS.load(Ordering::Acquire) > 0;
            let _ = send_line(
                &mut pipe,
                &PipeEvent::Status {
                    version: SERVICE_VERSION.to_owned(),
                    busy,
                },
            );
        }
        PipeCommand::Start {
            mut settings,
            port,
            mut routing_mode,
            recover,
            options,
        } => {
            let Ok(_lock) = mutex.try_lock() else {
                let _ = send_line(
                    &mut pipe,
                    &PipeEvent::Error {
                        message: "另一个 TUN 会话正在服务中运行".into(),
                    },
                );
                return;
            };
            ACTIVE_SESSIONS.fetch_add(1, Ordering::AcqRel);
            struct ActiveGuard;
            impl Drop for ActiveGuard {
                fn drop(&mut self) {
                    ACTIVE_SESSIONS.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _guard = ActiveGuard;

            let exe = match env::current_exe() {
                Ok(exe) => exe,
                Err(_) => {
                    let _ = send_line(
                        &mut pipe,
                        &PipeEvent::Error {
                            message: "无法定位服务程序路径".into(),
                        },
                    );
                    return;
                }
            };
            let mut session = match Session::start_using_with_options(
                settings.clone(),
                port,
                "tun",
                routing_mode,
                &exe,
                recover,
                options,
            ) {
                Ok(session) => session,
                Err(error) => {
                    let _ = send_line(&mut pipe, &PipeEvent::Error { message: error });
                    return;
                }
            };
            if send_line(
                &mut pipe,
                &PipeEvent::Ready {
                    id: session.id.clone(),
                    port: session.port,
                    controller: session.controller.clone(),
                    tun_interface: session.active_tun_interface(),
                    tun_ipv6: session.tun_ipv6,
                    allow_lan: session.allow_lan,
                },
            )
            .is_err()
            {
                let _ = session.stop();
                return;
            }
            let raw = reader_pipe.as_raw_handle() as HANDLE;
            let mut last_recovering = session.recovering_tun();
            let mut last_generation = session.generation();
            let mut graceful_stop = false;

            while !STOP_REQUESTED.load(Ordering::Acquire) {
                let mut avail = 0u32;
                if unsafe {
                    PeekNamedPipe(
                        raw,
                        ptr::null_mut(),
                        0,
                        ptr::null_mut(),
                        &mut avail,
                        ptr::null_mut(),
                    )
                } == 0
                {
                    let err = unsafe { GetLastError() };
                    if err == ERROR_BROKEN_PIPE || err != 0 {
                        break;
                    }
                }
                while avail > 0 {
                    let mut buf = vec![0u8; (avail as usize).min(65536)];
                    match reader_pipe.read(&mut buf) {
                        Ok(0) | Err(_) => {
                            graceful_stop = true;
                            break;
                        }
                        Ok(n) => {
                            pending.extend_from_slice(&buf[..n]);
                            while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                                let line_raw: Vec<u8> = pending.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_raw);
                                if let Ok(next_cmd) =
                                    serde_json::from_str::<PipeCommand>(line.trim())
                                {
                                    match next_cmd {
                                        PipeCommand::Stop => {
                                            graceful_stop = true;
                                        }
                                        PipeCommand::SetRecovery { enabled } => {
                                            session.configure_tun_recovery(enabled);
                                        }
                                        PipeCommand::SyncRouting {
                                            routing_mode: next_mode,
                                            config,
                                        } => {
                                            routing_mode = next_mode;
                                            settings.config = config;
                                            session.remember_tun_route(next_mode, &settings.config);
                                        }
                                        PipeCommand::SyncMihomo { config, selections } => {
                                            settings.config = config;
                                            settings.selections = selections;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    if graceful_stop || pending.len() > 16 * 1024 * 1024 {
                        break;
                    }
                    let mut next_avail = 0u32;
                    if unsafe {
                        PeekNamedPipe(
                            raw,
                            ptr::null_mut(),
                            0,
                            ptr::null_mut(),
                            &mut next_avail,
                            ptr::null_mut(),
                        )
                    } == 0
                    {
                        break;
                    }
                    avail = next_avail;
                }
                if graceful_stop || !session.running() {
                    break;
                }
                if session.needs_mihomo_restart() {
                    let _ = session.stage_mihomo_restart(&settings, routing_mode);
                }
                let recovering = session.recovering_tun();
                let generation = session.generation();
                if recovering != last_recovering || generation != last_generation {
                    last_recovering = recovering;
                    last_generation = generation;
                    if send_line(
                        &mut pipe,
                        &PipeEvent::State {
                            running: true,
                            recovering,
                            generation,
                            tun_interface: session.active_tun_interface(),
                        },
                    )
                    .is_err()
                    {
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = session.stop();
            let _ = send_line(&mut pipe, &PipeEvent::Stopped);
        }
        _ => {
            let _ = send_line(
                &mut pipe,
                &PipeEvent::Error {
                    message: "当前阶段仅支持 status 或 start 指令".into(),
                },
            );
        }
    }
    let _ = unsafe { DisconnectNamedPipe(pipe.as_raw_handle() as HANDLE) };
}

unsafe extern "system" fn service_main(_argc: DWORD, _argv: *mut *mut u16) {
    let name = wide(SERVICE_NAME);
    let handle = RegisterServiceCtrlHandlerW(name.as_ptr(), Some(ctrl_handler));
    if handle.is_null() {
        return;
    }
    STATUS_HANDLE.store(handle as usize, Ordering::Release);
    report_status(SERVICE_START_PENDING, 3000, 0);
    STOP_REQUESTED.store(false, Ordering::Release);
    report_status(SERVICE_RUNNING, 0, 0);

    while !STOP_REQUESTED.load(Ordering::Acquire) {
        let Ok(pipe) = create_pipe_instance() else {
            thread::sleep(Duration::from_millis(250));
            continue;
        };
        let raw = pipe.as_raw_handle() as HANDLE;
        let connected = ConnectNamedPipe(raw, ptr::null_mut()) != 0
            || GetLastError() == ERROR_PIPE_CONNECTED;
        if STOP_REQUESTED.load(Ordering::Acquire) {
            let _ = DisconnectNamedPipe(raw);
            break;
        }
        if connected {
            thread::spawn(move || handle_pipe_client(pipe));
        }
    }

    let deadline = Instant::now() + Duration::from_secs(6);
    while ACTIVE_SESSIONS.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    report_status(SERVICE_STOPPED, 0, 0);
}

fn run_service() -> Result<(), String> {
    SERVICE_PROCESS.store(true, Ordering::Release);
    let name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: ptr::null(),
            lpServiceProc: None,
        },
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err("只能在 Windows 服务控制管理器下运行 --tun-service".into());
    }
    Ok(())
}

pub fn cli() -> Option<i32> {
    let arg = env::args().nth(1)?;
    match arg.as_str() {
        "--tun-service" => Some(if run_service().is_ok() { 0 } else { 1 }),
        "--install-service" => Some(match install_current() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        }),
        "--uninstall-service" => Some(match uninstall() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_protocol_round_trips_commands_and_events() {
        let cmd = PipeCommand::SyncRouting {
            routing_mode: RoutingMode::Global,
            config: serde_json::json!({"outbounds": [{"default": "node-1"}]}),
        };
        let encoded = serde_json::to_string(&cmd).unwrap();
        let decoded: PipeCommand = serde_json::from_str(&encoded).unwrap();
        assert!(matches!(
            decoded,
            PipeCommand::SyncRouting {
                routing_mode: RoutingMode::Global,
                ..
            }
        ));

        let evt = PipeEvent::State {
            running: true,
            recovering: true,
            generation: 2,
            tun_interface: Some("RelayDesk-fixture".into()),
        };
        let encoded_evt = serde_json::to_string(&evt).unwrap();
        let decoded_evt: PipeEvent = serde_json::from_str(&encoded_evt).unwrap();
        assert!(matches!(
            decoded_evt,
            PipeEvent::State {
                running: true,
                recovering: true,
                generation: 2,
                ..
            }
        ));
    }

    #[test]
    fn pipe_sddl_security_descriptor_parses_cleanly() {
        let sddl = wide("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)");
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut sd,
                ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        assert!(!sd.is_null());
        let _guard = LocalSd(sd);
    }
}
