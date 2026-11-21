use super::{event_name, Handle, RoutingMode};
use serde_json::{json, Value};
use std::{
    ptr,
    sync::atomic::{AtomicU32, Ordering},
};
use winapi::{
    shared::minwindef::FALSE,
    um::{
        handleapi::INVALID_HANDLE_VALUE,
        memoryapi::{
            CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_WRITE,
        },
        winnt::PAGE_READWRITE,
    },
};

#[repr(C)]
struct TunControlValues {
    recover: AtomicU32,
    routing: AtomicU32,
    phase: AtomicU32,
    interface_len: AtomicU32,
    interface_words: [AtomicU32; 8],
}

pub(super) struct TunControl {
    values: ptr::NonNull<TunControlValues>,
    _mapping: Handle,
}
// The page-backed mapping stays live until Drop. Accesses to its fixed fields are atomic.
unsafe impl Send for TunControl {}

impl TunControl {
    pub(super) fn open(token: &str) -> Result<Self, String> {
        let name = event_name(token, "tun-control");
        let handle =
            Handle::new(unsafe { OpenFileMappingW(FILE_MAP_WRITE, FALSE, name.as_ptr()) })?;
        Self::map(handle)
    }

    pub(super) fn create(
        token: &str,
        recover: bool,
        mode: RoutingMode,
        config: &Value,
    ) -> Result<Self, String> {
        let name = event_name(token, "tun-control");
        let handle = Handle::new(unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                ptr::null_mut(),
                PAGE_READWRITE,
                0,
                std::mem::size_of::<TunControlValues>() as u32,
                name.as_ptr(),
            )
        })?;
        let control = Self::map(handle)?;
        control.set_recovery(recover);
        control.set_routing(mode, config);
        Ok(control)
    }

    fn map(handle: Handle) -> Result<Self, String> {
        let view = unsafe {
            MapViewOfFile(
                handle.0,
                FILE_MAP_WRITE,
                0,
                0,
                std::mem::size_of::<TunControlValues>(),
            )
        };
        let values = ptr::NonNull::new(view.cast()).ok_or("无法连接 TUN 恢复状态")?;
        Ok(Self {
            values,
            _mapping: handle,
        })
    }

    fn values(&self) -> &TunControlValues {
        unsafe { self.values.as_ref() }
    }

    pub(super) fn set_recovery(&self, enabled: bool) {
        self.values()
            .recover
            .store(u32::from(enabled), Ordering::Release);
    }

    pub(super) fn enabled(&self) -> bool {
        self.values().recover.load(Ordering::Acquire) == 1
    }

    pub(super) fn set_routing(&self, mode: RoutingMode, config: &Value) {
        let mode = match mode {
            RoutingMode::Rule => 0,
            RoutingMode::Global => 1,
            RoutingMode::Direct => 2,
        };
        let node = config["outbounds"][0]["default"]
            .as_str()
            .and_then(|tag| tag.strip_prefix("node-"))
            .and_then(|index| index.parse::<u32>().ok())
            .filter(|index| *index < 2048)
            .map_or(0, |index| index + 1);
        self.values()
            .routing
            .store((mode << 16) | node, Ordering::Release);
    }

    pub(super) fn restore_routing(&self, config: &mut Value) {
        let routing = self.values().routing.load(Ordering::Acquire);
        let mode = match routing >> 16 {
            0 => RoutingMode::Rule,
            1 => RoutingMode::Global,
            2 => RoutingMode::Direct,
            _ => return,
        };
        config["experimental"]["clash_api"]["default_mode"] = json!(mode.name());
        if let Some(node) = (routing & 0xffff)
            .checked_sub(1)
            .filter(|index| *index < 2048)
        {
            let tag = format!("node-{node}");
            if config["outbounds"][0]["outbounds"]
                .as_array()
                .is_some_and(|choices| {
                    choices
                        .iter()
                        .any(|choice| choice.as_str() == Some(tag.as_str()))
                })
            {
                config["outbounds"][0]["default"] = json!(tag);
            }
        }
    }

    pub(super) fn routing_mode(&self) -> RoutingMode {
        match self.values().routing.load(Ordering::Acquire) >> 16 {
            1 => RoutingMode::Global,
            2 => RoutingMode::Direct,
            _ => RoutingMode::Rule,
        }
    }

    pub(super) fn set_interface(&self, name: &str) {
        let bytes = name.as_bytes();
        let len = bytes.len().min(32);
        // Publish length=0 before updating words so concurrent readers never see half-written names.
        self.values().interface_len.store(0, Ordering::Release);
        let mut padded = [0u8; 32];
        padded[..len].copy_from_slice(&bytes[..len]);
        for (slot, chunk) in self.values().interface_words.iter().zip(padded.chunks_exact(4)) {
            let word = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            slot.store(word, Ordering::Relaxed);
        }
        self.values().interface_len.store(len as u32, Ordering::Release);
    }

    pub(super) fn interface(&self) -> Option<String> {
        let len = self.values().interface_len.load(Ordering::Acquire) as usize;
        if len == 0 || len > 32 {
            return None;
        }
        let mut buf = [0u8; 32];
        for (slot, chunk) in self.values().interface_words.iter().zip(buf.chunks_exact_mut(4)) {
            chunk.copy_from_slice(&slot.load(Ordering::Relaxed).to_le_bytes());
        }
        std::str::from_utf8(&buf[..len]).ok().map(str::to_owned)
    }

    pub(super) fn begin_recovery(&self) {
        self.values().phase.fetch_or(1, Ordering::AcqRel);
    }

    pub(super) fn finish_recovery(&self) {
        self.values().phase.fetch_add(1, Ordering::AcqRel);
    }

    pub(super) fn recovering(&self) -> bool {
        self.values().phase.load(Ordering::Acquire) & 1 != 0
    }

    pub(super) fn generation(&self) -> u32 {
        self.values().phase.load(Ordering::Acquire) >> 1
    }
}

impl Drop for TunControl {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.values.as_ptr().cast());
        }
    }
}
