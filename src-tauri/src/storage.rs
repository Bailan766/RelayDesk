use rusqlite::{params, Connection};
use std::{fs, path::PathBuf, ptr};
use tauri::Manager;
use winapi::um::{dpapi::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN}, winbase::LocalFree, wincrypt::DATA_BLOB};

pub(crate) fn transform(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    const LIMIT: usize = 32 * 1024 * 1024;
    let limit = if encrypt { LIMIT } else { LIMIT + 64 * 1024 };
    if input.len() > limit { return Err("订阅和规则数据过大".into()); }
    let mut source = DATA_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut output = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(&mut source, ptr::null(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&mut source, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("Windows 数据保护操作失败".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut _); }
    Ok(result)
}

fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir: PathBuf = app.path().app_data_dir().map_err(|_| "无法定位应用数据目录")?;
    fs::create_dir_all(&dir).map_err(|_| "无法创建应用数据目录")?;
    let conn = Connection::open(dir.join("relaydesk.db")).map_err(|_| "无法打开订阅数据库")?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS subscription (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS subscription_backup (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);",
    )
    .map_err(|_| "无法初始化订阅数据库")?;
    Ok(conn)
}

fn store(conn: &Connection, data: &str) -> Result<(), String> {
    let encrypted = transform(data.as_bytes(), true)?;
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|_| "无法锁定订阅数据库")?;
    let write_res = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO subscription_backup (id, encrypted)
             SELECT 1, encrypted FROM subscription WHERE id = 1
             ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted",
            [],
        )
        .map_err(|_| "无法备份上一份订阅配置")?;
        conn.execute(
            "INSERT INTO subscription (id, encrypted) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted",
            params![encrypted],
        )
        .map_err(|_| "无法保存订阅")?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = conn.execute_batch("ROLLBACK;");
        return Err(err);
    }
    conn.execute_batch("COMMIT;")
        .map_err(|_| "无法提交订阅保存事务".into())
}

fn read_encrypted_row(conn: &Connection, table: &str) -> Result<Option<Vec<u8>>, String> {
    let sql = format!("SELECT encrypted FROM {table} WHERE id=1");
    let mut stmt = conn.prepare(&sql).map_err(|_| "无法读取订阅")?;
    let mut rows = stmt.query([]).map_err(|_| "无法读取订阅")?;
    match rows.next().map_err(|_| "无法读取订阅")? {
        Some(row) => row.get::<_, Vec<u8>>(0).map(Some).map_err(|_| "订阅数据无效".into()),
        None => Ok(None),
    }
}

fn load_from(conn: &Connection) -> Result<Option<String>, String> {
    if let Some(primary) = read_encrypted_row(conn, "subscription")? {
        if let Ok(plain) = transform(&primary, false) {
            if let Ok(text) = String::from_utf8(plain) {
                return Ok(Some(text));
            }
        }
        if let Ok(Some(backup)) = read_encrypted_row(conn, "subscription_backup") {
            let plain = transform(&backup, false)?;
            let text = String::from_utf8(plain).map_err(|_| "订阅备份数据无效")?;
            crate::logs::append("storage", "warn", "主配置记录损坏，已自动回退到上一份热备");
            return Ok(Some(text));
        }
        return Err("订阅数据已损坏".into());
    }
    if let Ok(Some(backup)) = read_encrypted_row(conn, "subscription_backup") {
        let plain = transform(&backup, false)?;
        let text = String::from_utf8(plain).map_err(|_| "订阅备份数据无效")?;
        crate::logs::append("storage", "warn", "主配置记录缺失，已自动回退到上一份热备");
        return Ok(Some(text));
    }
    Ok(None)
}

#[tauri::command]
pub fn save_subscription(app: tauri::AppHandle, data: String) -> Result<(), String> {
    store(&database(&app)?, &data)
}

#[tauri::command]
pub fn load_subscription(app: tauri::AppHandle) -> Result<Option<String>, String> {
    load_from(&database(&app)?)
}

#[cfg(test)]
mod tests {
    use super::{load_from, store, transform};
    use rusqlite::Connection;
    #[test]
    fn encrypted_data_roundtrips_without_plaintext() {
        let plaintext = b"subscription-secret-example";
        let ciphertext = transform(plaintext, true).unwrap();
        assert!(!ciphertext.windows(plaintext.len()).any(|part| part == plaintext));
        assert_eq!(transform(&ciphertext, false).unwrap(), plaintext);
    }
    #[test]
    fn failed_update_preserves_encrypted_previous_subscription() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE subscription (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);
             CREATE TABLE subscription_backup (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);",
        )
        .unwrap();
        store(&conn, "previous-secret").unwrap();
        assert!(store(&conn, &"x".repeat(32 * 1024 * 1024 + 1)).is_err());
        let encrypted: Vec<u8> = conn.query_row("SELECT encrypted FROM subscription WHERE id=1", [], |row| row.get(0)).unwrap();
        assert!(!encrypted.windows(15).any(|part| part == b"previous-secret"));
        assert_eq!(transform(&encrypted, false).unwrap(), b"previous-secret");
    }
    #[test]
    fn corrupted_primary_falls_back_to_backup_row() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE subscription (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);
             CREATE TABLE subscription_backup (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);",
        )
        .unwrap();
        store(&conn, "first-good").unwrap();
        store(&conn, "second-good").unwrap();
        assert_eq!(load_from(&conn).unwrap().as_deref(), Some("second-good"));
        conn.execute("UPDATE subscription SET encrypted = X'DEADBEEF' WHERE id = 1", [])
            .unwrap();
        assert_eq!(load_from(&conn).unwrap().as_deref(), Some("first-good"));
    }
}
