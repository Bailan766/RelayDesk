use rusqlite::{params, Connection};
use std::{fs, path::PathBuf, ptr};
use tauri::Manager;
use winapi::um::{dpapi::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN}, winbase::LocalFree, wincrypt::DATA_BLOB};

fn transform(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if input.len() > 8 * 1024 * 1024 { return Err("订阅数据过大".into()); }
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
    conn.execute_batch("CREATE TABLE IF NOT EXISTS subscription (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL)")
        .map_err(|_| "无法初始化订阅数据库")?;
    Ok(conn)
}

#[tauri::command]
pub fn save_subscription(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let encrypted = transform(data.as_bytes(), true)?;
    database(&app)?.execute("INSERT INTO subscription (id, encrypted) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted", params![encrypted])
        .map_err(|_| "无法保存订阅")?;
    Ok(())
}

#[tauri::command]
pub fn load_subscription(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let conn = database(&app)?;
    let mut stmt = conn.prepare("SELECT encrypted FROM subscription WHERE id=1").map_err(|_| "无法读取订阅")?;
    let mut rows = stmt.query([]).map_err(|_| "无法读取订阅")?;
    match rows.next().map_err(|_| "无法读取订阅")? {
        Some(row) => {
            let encrypted: Vec<u8> = row.get(0).map_err(|_| "订阅数据无效")?;
            String::from_utf8(transform(&encrypted, false)?).map(Some).map_err(|_| "订阅数据无效".into())
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::transform;
    #[test]
    fn encrypted_data_roundtrips_without_plaintext() {
        let plaintext = b"subscription-secret-example";
        let ciphertext = transform(plaintext, true).unwrap();
        assert!(!ciphertext.windows(plaintext.len()).any(|part| part == plaintext));
        assert_eq!(transform(&ciphertext, false).unwrap(), plaintext);
    }
}
