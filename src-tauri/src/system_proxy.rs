use serde::{Deserialize, Serialize};
use std::{ffi::c_void, fs, io::Write, mem, path::Path, ptr};
use winapi::um::winbase::GlobalFree;

const PER_CONNECTION: u32 = 75;
const PROXY_FLAGS: u32 = 0x0f;

#[repr(C)]
union Value {
    number: u32,
    string: *mut u16,
    file_time: [u32; 2],
}

#[repr(C)]
struct OptionValue {
    option: u32,
    value: Value,
}

#[repr(C)]
struct OptionList {
    size: u32,
    connection: *mut u16,
    count: u32,
    error: u32,
    options: *mut OptionValue,
}

#[link(name = "wininet")]
extern "system" {
    fn InternetQueryOptionW(
        handle: *mut c_void,
        option: u32,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
    fn InternetSetOptionW(handle: *mut c_void, option: u32, data: *mut c_void, size: u32) -> i32;
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct Settings {
    flags: u32,
    server: Vec<u16>,
    bypass: Vec<u16>,
    pac: Vec<u16>,
}

#[derive(Deserialize, Serialize)]
struct Journal {
    previous: Settings,
    active: Settings,
}

fn list(options: &mut [OptionValue]) -> OptionList {
    OptionList {
        size: mem::size_of::<OptionList>() as u32,
        connection: ptr::null_mut(),
        count: options.len() as u32,
        error: 0,
        options: options.as_mut_ptr(),
    }
}

fn query() -> Result<Settings, ()> {
    // FLAGS_UI includes the user's manually configured auto-detect state.
    for flag_option in [10, 1] {
        let mut values = [flag_option, 2, 3, 4].map(|option| OptionValue {
            option,
            value: Value {
                string: ptr::null_mut(),
            },
        });
        let mut request = list(&mut values);
        let mut size = request.size;
        let ok = unsafe {
            InternetQueryOptionW(
                ptr::null_mut(),
                PER_CONNECTION,
                (&mut request as *mut OptionList).cast(),
                &mut size,
            )
        } != 0;
        let strings: Vec<Vec<u16>> = values[1..]
            .iter()
            .map(|value| unsafe {
                let data = value.value.string;
                if data.is_null() {
                    return Vec::new();
                }
                let mut len = 0;
                while *data.add(len) != 0 {
                    len += 1;
                }
                let string = std::slice::from_raw_parts(data, len).to_vec();
                GlobalFree(data.cast());
                string
            })
            .collect();
        if ok {
            let [server, bypass, pac]: [Vec<u16>; 3] = strings.try_into().map_err(|_| ())?;
            return Ok(Settings {
                flags: unsafe { values[0].value.number },
                server,
                bypass,
                pac,
            });
        }
    }
    Err(())
}

fn apply(settings: &Settings) -> Result<(), ()> {
    let mut strings = [&settings.server, &settings.bypass, &settings.pac]
        .map(|value| value.iter().copied().chain([0]).collect::<Vec<_>>());
    let mut values = [
        OptionValue {
            option: 1,
            value: Value {
                number: settings.flags,
            },
        },
        OptionValue {
            option: 2,
            value: Value {
                string: strings[0].as_mut_ptr(),
            },
        },
        OptionValue {
            option: 3,
            value: Value {
                string: strings[1].as_mut_ptr(),
            },
        },
        OptionValue {
            option: 4,
            value: Value {
                string: strings[2].as_mut_ptr(),
            },
        },
    ];
    let mut request = list(&mut values);
    unsafe {
        if InternetSetOptionW(
            ptr::null_mut(),
            PER_CONNECTION,
            (&mut request as *mut OptionList).cast(),
            request.size,
        ) == 0
        {
            return Err(());
        }
        for option in [39, 37] {
            InternetSetOptionW(ptr::null_mut(), option, ptr::null_mut(), 0);
        }
    }
    Ok(())
}

pub fn recover(path: &Path) -> Result<(), ()> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(()),
    };
    let journal: Journal = serde_json::from_slice(&raw).map_err(|_| ())?;
    let mut current = query()?;
    if current.server == journal.active.server {
        if current.bypass == journal.active.bypass {
            current.bypass = journal.previous.bypass;
        }
        if current.pac == journal.active.pac {
            current.pac = journal.previous.pac;
        }
        let unchanged = PROXY_FLAGS & !(current.flags ^ journal.active.flags);
        current.flags = (current.flags & !unchanged) | (journal.previous.flags & unchanged);
        current.server = journal.previous.server;
        apply(&current)?;
    }
    fs::remove_file(path).map_err(|_| ())
}

pub fn enable(path: &Path, port: u16) -> Result<(), ()> {
    enable_with_bypass(
        path,
        port,
        "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;[::1];<local>",
    )
}

pub fn enable_with_bypass(path: &Path, port: u16, bypass: &str) -> Result<(), ()> {
    let bypass = if bypass.trim().is_empty() {
        "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;[::1];<local>"
    } else {
        bypass.trim()
    };
    let journal = Journal {
        previous: query()?,
        active: Settings {
            flags: 3,
            server: format!("127.0.0.1:{port}").encode_utf16().collect(),
            bypass: bypass.encode_utf16().collect(),
            pac: Vec::new(),
        },
    };
    let raw = serde_json::to_vec(&journal).map_err(|_| ())?;
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary).map_err(|_| ())?;
    file.write_all(&raw)
        .and_then(|_| file.sync_all())
        .map_err(|_| ())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|_| ())?;
    if apply(&journal.active).is_err()
        || !query().is_ok_and(|actual| {
            actual.flags & PROXY_FLAGS == journal.active.flags
                && actual.server == journal.active.server
        })
    {
        if apply(&journal.previous).is_ok() {
            let _ = fs::remove_file(path);
        }
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn windows_restores_pac_and_keeps_user_changes_to_auto_detection() {
        if std::env::var_os("RELAYDESK_WINDOWS_PROXY_SMOKE").is_none() {
            return;
        }
        struct Restore(Settings, PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = apply(&self.0);
                let _ = fs::remove_file(&self.1);
                let _ = fs::remove_file(self.1.with_extension("tmp"));
            }
        }
        let journal = std::env::temp_dir().join(format!(
            "relaydesk-proxy-fixture-{}.json",
            uuid::Uuid::new_v4()
        ));
        let restore = Restore(query().unwrap(), journal);
        let path = &restore.1;
        let wide = |text: &str| text.encode_utf16().collect::<Vec<_>>();

        let initial = Settings {
            flags: 1 | 4 | 8,
            server: wide("127.0.0.1:9"),
            bypass: wide("*.fixture.test;<local>"),
            pac: wide("https://fixture.invalid/settings.pac"),
        };
        apply(&initial).unwrap();
        let baseline = query().unwrap();
        assert_eq!(baseline.flags & PROXY_FLAGS, initial.flags);
        assert_eq!(baseline.pac, initial.pac);
        assert_eq!(baseline.bypass, initial.bypass);
        enable(path, 19371).unwrap();
        assert_eq!(query().unwrap().flags & PROXY_FLAGS, 3);
        recover(path).unwrap();
        assert_eq!(query().unwrap(), baseline);

        let initial = Settings {
            flags: 1,
            server: Vec::new(),
            bypass: Vec::new(),
            pac: Vec::new(),
        };
        apply(&initial).unwrap();
        let baseline = query().unwrap();
        enable(path, 19371).unwrap();
        let mut edited = query().unwrap();
        edited.flags |= 8;
        apply(&edited).unwrap();
        assert_eq!(query().unwrap().flags & PROXY_FLAGS, 11);
        recover(path).unwrap();
        let restored = query().unwrap();
        assert_eq!(restored.flags & PROXY_FLAGS, 9);
        assert_eq!(restored.server, baseline.server);

        enable(path, 19371).unwrap();
        let external = Settings {
            flags: 3,
            server: wide("127.0.0.1:9"),
            ..initial
        };
        apply(&external).unwrap();
        let external = query().unwrap();
        recover(path).unwrap();
        assert_eq!(query().unwrap(), external);
        assert!(!path.exists());
        apply(&restore.0).unwrap();
        assert_eq!(query().unwrap(), restore.0);
    }
}
