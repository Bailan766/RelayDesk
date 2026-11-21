use crate::supervisor::Supervisor;
use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use winapi::{
    shared::{
        minwindef::{LPARAM, LRESULT, UINT, WPARAM},
        windef::HWND,
    },
    um::{
        libloaderapi::GetModuleHandleW,
        winnt::HANDLE,
        winuser::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
            RegisterClassExW, TranslateMessage, MSG, WM_DESTROY, WM_POWERBROADCAST, WNDCLASSEXW,
        },
    },
};

const AF_UNSPEC: u16 = 0;
const PBT_APMSUSPEND: usize = 0x0004;
const PBT_APMRESUMESUSPEND: usize = 0x0007;
const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

static LAST_IF_EVENT_MS: AtomicU64 = AtomicU64::new(0);
static LAST_POWER_RESUME_MS: AtomicU64 = AtomicU64::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[link(name = "iphlpapi")]
extern "system" {
    fn NotifyIpInterfaceChange(
        family: u16,
        callback: unsafe extern "system" fn(
            caller_context: *mut c_void,
            row: *const c_void,
            notification_type: u32,
        ),
        caller_context: *mut c_void,
        initial_notification: u8,
        notification_handle: *mut HANDLE,
    ) -> u32;
    fn CancelMibChangeNotify2(notification_handle: HANDLE) -> u32;
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkWatchEvent {
    kind: &'static str,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

unsafe extern "system" fn interface_change_cb(
    _caller_context: *mut c_void,
    _row: *const c_void,
    notification_type: u32,
) {
    // 3 = MibInitialNotification
    if notification_type == 3 {
        return;
    }
    LAST_IF_EVENT_MS.store(now_ms(), Ordering::Release);
}

unsafe extern "system" fn power_wnd_proc(
    hwnd: HWND,
    msg: UINT,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_POWERBROADCAST {
        if let Some(app) = APP_HANDLE.get() {
            match wparam {
                PBT_APMSUSPEND => {
                    crate::logs::append("netwatch", "info", "系统即将进入睡眠/休眠");
                    let _ = app.emit("network-watch", NetworkWatchEvent { kind: "suspend" });
                }
                PBT_APMRESUMESUSPEND | PBT_APMRESUMEAUTOMATIC => {
                    let now = now_ms();
                    let prev = LAST_POWER_RESUME_MS.swap(now, Ordering::AcqRel);
                    if now.saturating_sub(prev) >= 2000 {
                        app.state::<Supervisor>().on_network_change("system-resumed");
                        let _ = app.emit("network-watch", NetworkWatchEvent { kind: "resume" });
                    }
                }
                _ => {}
            }
        }
        return 1;
    }
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

struct MibHandle(HANDLE);
unsafe impl Send for MibHandle {}
impl Drop for MibHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CancelMibChangeNotify2(self.0);
            }
        }
    }
}

pub fn start(app: tauri::AppHandle) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = APP_HANDLE.set(app.clone());

    // Debounce thread for NotifyIpInterfaceChange
    let if_app = app.clone();
    thread::spawn(move || {
        let mut handle: HANDLE = ptr::null_mut();
        let status = unsafe {
            NotifyIpInterfaceChange(
                AF_UNSPEC,
                interface_change_cb,
                ptr::null_mut(),
                0,
                &mut handle,
            )
        };
        if status != 0 || handle.is_null() {
            crate::logs::append("netwatch", "warn", &format!("未能注册网卡变更监听 ({status})"));
            return;
        }
        let _guard = MibHandle(handle);
        let mut handled_stamp = 0u64;
        loop {
            thread::sleep(Duration::from_millis(250));
            let stamp = LAST_IF_EVENT_MS.load(Ordering::Acquire);
            if stamp == 0 || stamp == handled_stamp {
                continue;
            }
            if now_ms().saturating_sub(stamp) < 1500 {
                continue;
            }
            handled_stamp = stamp;
            let state = if_app.state::<Supervisor>();
            // Skip notifications emitted immediately while TUN adapter is coming up.
            if state
                .session_uptime()
                .is_some_and(|elapsed| elapsed < Duration::from_secs(4))
            {
                continue;
            }
            state.on_network_change("interface-changed");
            let _ = if_app.emit("network-watch", NetworkWatchEvent { kind: "interface" });
        }
    });

    // Dedicated top-level invisible window thread for WM_POWERBROADCAST suspend/resume broadcasts.
    // Message-only windows (HWND_MESSAGE) do not receive broadcast messages in Win32.
    thread::spawn(move || unsafe {
        let class_name: Vec<u16> = "RelayDeskPowerWatch\0".encode_utf16().collect();
        let hinstance = GetModuleHandleW(ptr::null());
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(power_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: ptr::null_mut(),
            hCursor: ptr::null_mut(),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: ptr::null_mut(),
        };
        if RegisterClassExW(&wc) == 0 {
            return;
        }
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            hinstance,
            ptr::null_mut(),
        );
        if hwnd.is_null() {
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
