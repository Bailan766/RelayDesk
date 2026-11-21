use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 1_048_576;
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn log_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("RelayDesk")
        .join("logs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn log_file_path() -> Option<PathBuf> {
    Some(log_dir()?.join("relaydesk.log"))
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn format_utc_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    // Howard Hinnant civil_from_days (UTC epoch 1970-01-01)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

pub fn append(source: &str, level: &str, message: &str) {
    let Some(path) = log_file_path() else {
        return;
    };
    let clean = crate::telemetry::redact_log_payload(message);
    if clean.is_empty() {
        return;
    }
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    if fs::metadata(&path).is_ok_and(|meta| meta.len() >= MAX_LOG_BYTES) {
        let backup = path.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(&path, &backup);
    }
    let ts = unix_now();
    let line = format!("{} [{}] [{}] ({}) {}\n", format_utc_iso(ts), level, source, ts, clean);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn read_tail(limit: usize) -> Vec<(u64, &'static str, String)> {
    let Some(path) = log_file_path() else {
        return Vec::new();
    };
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let read_from = len.saturating_sub(64 * 1024);
    if file.seek(SeekFrom::Start(read_from)).is_err() {
        return Vec::new();
    }
    let mut raw = String::new();
    if file.read_to_string(&mut raw).is_err() {
        return Vec::new();
    }
    let mut parsed = Vec::new();
    for line in raw.lines().skip(usize::from(read_from > 0)) {
        if let Some(entry) = parse_log_line(line) {
            parsed.push(entry);
        }
    }
    if parsed.len() > limit {
        parsed.drain(..parsed.len() - limit);
    }
    parsed
}

pub fn clear_disk_logs() {
    let Some(path) = log_file_path() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(path.with_extension("log.1"));
}

fn parse_log_line(line: &str) -> Option<(u64, &'static str, String)> {
    // Format: 2026-11-21T07:25:00Z [warn] [source] (1763709900) message
    let after_iso = line.split_once(" [")?.1;
    let (lvl, rest) = after_iso.split_once("] [")?;
    let level = match lvl {
        "error" => "error",
        "warn" => "warn",
        "info" => "info",
        _ => return None,
    };
    let (_, after_src) = rest.split_once("] (")?;
    let (ts_str, msg) = after_src.split_once(") ")?;
    let ts = ts_str.parse::<u64>().ok()?;
    Some((ts, level, msg.to_owned()))
}
