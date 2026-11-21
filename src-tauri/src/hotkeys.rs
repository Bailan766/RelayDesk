use std::{
    ptr,
    sync::{mpsc, Mutex},
    thread,
};
use tauri::Emitter;
use winapi::um::{
    processthreadsapi::GetCurrentThreadId,
    winuser::{
        GetMessageW, PostThreadMessageW, RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL,
        MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, MSG, WM_APP, WM_HOTKEY, WM_QUIT,
    },
};

const ID_TOGGLE_PROXY: i32 = 1;
const ID_CYCLE_ROUTING: i32 = 2;
const ID_SHOW_WINDOW: i32 = 3;

const WM_RELOAD_HOTKEYS: u32 = WM_APP + 1;

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    #[serde(default)]
    pub toggle_proxy: String,
    #[serde(default)]
    pub cycle_routing: String,
    #[serde(default)]
    pub show_window: String,
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyApplyResult {
    pub toggle_proxy_error: Option<String>,
    pub cycle_routing_error: Option<String>,
    pub show_window_error: Option<String>,
}

pub fn parse_hotkey(spec: &str) -> Result<(u32, u32), String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    let parts: Vec<&str> = trimmed
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("全局快捷键至少需要包含一个修饰键（如 Ctrl / Alt / Shift）".into());
    }

    let mut modifiers = MOD_NOREPEAT as u32;
    for part in &parts[..parts.len() - 1] {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL as u32,
            "alt" => modifiers |= MOD_ALT as u32,
            "shift" => modifiers |= MOD_SHIFT as u32,
            "win" | "super" | "meta" => modifiers |= MOD_WIN as u32,
            other => return Err(format!("不支持的修饰键：{other}")),
        }
    }
    if modifiers == MOD_NOREPEAT as u32 {
        return Err("请至少选择一个修饰键".into());
    }

    let key = parts[parts.len() - 1].to_ascii_uppercase();
    let vk: u32 = if key.len() == 1 {
        let byte = key.as_bytes()[0];
        if byte.is_ascii_alphanumeric() {
            u32::from(byte)
        } else {
            return Err(format!("不支持的按键：{key}"));
        }
    } else if let Some(rest) = key.strip_prefix('F') {
        let num: u32 = rest
            .parse()
            .map_err(|_| format!("不支持的功能键：{key}"))?;
        if !(1..=12).contains(&num) {
            return Err(format!("仅支持 F1-F12：{key}"));
        }
        0x70 + (num - 1)
    } else {
        match key.as_str() {
            "SPACE" => 0x20,
            "TAB" => 0x09,
            "INSERT" => 0x2D,
            "DELETE" => 0x2E,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22,
            "UP" => 0x26,
            "DOWN" => 0x28,
            "LEFT" => 0x25,
            "RIGHT" => 0x27,
            _ => return Err(format!("不支持的按键：{key}")),
        }
    };

    Ok((modifiers, vk))
}

struct PendingApply {
    config: HotkeyConfig,
    reply: mpsc::SyncSender<HotkeyApplyResult>,
}

pub struct HotkeyManager {
    thread_id: u32,
    pending: std::sync::Arc<Mutex<Option<PendingApply>>>,
}

impl HotkeyManager {
    pub fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let (tid_tx, tid_rx) = mpsc::sync_channel::<u32>(1);
        let pending = std::sync::Arc::new(Mutex::new(None::<PendingApply>));
        let worker_pending = std::sync::Arc::clone(&pending);

        thread::spawn(move || unsafe {
            let tid = GetCurrentThreadId();
            let _ = tid_tx.send(tid);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
                match msg.message {
                    WM_RELOAD_HOTKEYS => {
                        let task = worker_pending.lock().ok().and_then(|mut slot| slot.take());
                        if let Some(PendingApply { config, reply }) = task {
                            let res = apply_on_thread(&config);
                            let _ = reply.send(res);
                        }
                    }
                    WM_HOTKEY => match msg.wParam as i32 {
                        ID_TOGGLE_PROXY => {
                            let _ = app.emit("hotkey-action", "toggle");
                        }
                        ID_CYCLE_ROUTING => {
                            let _ = app.emit("hotkey-action", "cycle-routing");
                        }
                        ID_SHOW_WINDOW => {
                            crate::show_main(&app);
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            for id in [ID_TOGGLE_PROXY, ID_CYCLE_ROUTING, ID_SHOW_WINDOW] {
                UnregisterHotKey(ptr::null_mut(), id);
            }
        });

        let thread_id = tid_rx
            .recv()
            .map_err(|_| "无法初始化 Windows 全局快捷键线程".to_string())?;
        Ok(Self { thread_id, pending })
    }

    pub fn apply(&self, config: HotkeyConfig) -> Result<HotkeyApplyResult, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut guard = self.pending.lock().map_err(|_| "快捷键状态不可用")?;
            *guard = Some(PendingApply { config, reply: tx });
        }
        let posted = unsafe { PostThreadMessageW(self.thread_id, WM_RELOAD_HOTKEYS, 0, 0) };
        if posted == 0 {
            return Err("无法向快捷键线程发送更新指令".into());
        }
        rx.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|_| "应用全局快捷键超时".into())
    }

    pub fn shutdown(&self) {
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
        }
    }
}

unsafe fn register_slot(id: i32, spec: &str) -> Option<String> {
    let _ = UnregisterHotKey(ptr::null_mut(), id);
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (mods, vk) = match parse_hotkey(trimmed) {
        Ok(pair) => pair,
        Err(err) => return Some(err),
    };
    if RegisterHotKey(ptr::null_mut(), id, mods, vk) == 0 {
        return Some(format!("快捷键 {trimmed} 已被系统或其他软件占用"));
    }
    None
}

unsafe fn apply_on_thread(config: &HotkeyConfig) -> HotkeyApplyResult {
    HotkeyApplyResult {
        toggle_proxy_error: register_slot(ID_TOGGLE_PROXY, &config.toggle_proxy),
        cycle_routing_error: register_slot(ID_CYCLE_ROUTING, &config.cycle_routing),
        show_window_error: register_slot(ID_SHOW_WINDOW, &config.show_window),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_hotkey;

    #[test]
    fn parses_valid_hotkey_combinations_and_rejects_invalid_specs() {
        let (mods, vk) = parse_hotkey("ctrl+alt+p").unwrap();
        assert_eq!(vk, b'P' as u32);
        assert_ne!(mods, 0);

        let (_, vk_f9) = parse_hotkey("Ctrl+Shift+F9").unwrap();
        assert_eq!(vk_f9, 0x78);

        let (_, vk_space) = parse_hotkey("Alt+Space").unwrap();
        assert_eq!(vk_space, 0x20);

        assert!(parse_hotkey("").is_err());
        assert!(parse_hotkey("P").is_err());
        assert!(parse_hotkey("Unknown+P").is_err());
        assert!(parse_hotkey("Ctrl+F24").is_err());
    }
}
