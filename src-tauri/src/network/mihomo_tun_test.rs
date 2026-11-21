use super::*;
use std::io::{BufRead, BufReader, Read, Write};

const TARGET: &str = "198.18.117.33";
const UPDATED_TARGET: &str = "198.18.117.34";
const TUN_ADDRESS: &str = "172.28.254.1";

fn port(listener: &TcpListener) -> u16 {
    listener.local_addr().unwrap().port()
}

fn wait_until(mut condition: impl FnMut() -> bool, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(60));
    }
    assert!(
        condition(),
        "The expected Windows network state was not reached"
    );
}

fn stop_fixture_core(session: &Session, executable: &str) {
    use winapi::um::{
        handleapi::INVALID_HANDLE_VALUE,
        processthreadsapi::TerminateProcess,
        tlhelp32::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        winnt::PROCESS_TERMINATE,
    };
    let parent_id = unsafe { GetProcessId(session.worker.0) };
    assert_ne!(parent_id, 0);
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE);
    let snapshot = Handle::new(snapshot).unwrap();
    let mut row: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    row.dwSize = std::mem::size_of_val(&row) as u32;
    let mut present = unsafe { Process32FirstW(snapshot.0, &mut row) };
    let exe = wide(executable);
    while present != 0 {
        if row.th32ParentProcessID == parent_id && row.szExeFile.starts_with(&exe) {
            let child = Handle::new(unsafe {
                OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, row.th32ProcessID)
            })
            .unwrap();
            assert_ne!(unsafe { TerminateProcess(child.0, 1) }, 0);
            assert!(child.signaled(5000));
            return;
        }
        present = unsafe { Process32NextW(snapshot.0, &mut row) };
    }
    panic!("The worker's {executable} child was not found");
}

fn read_headers(socket: &mut TcpStream) -> String {
    let mut reader = BufReader::new(socket);
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    for line in reader.lines() {
        if line.unwrap().is_empty() {
            break;
        }
    }
    first
}

fn assert_http_through_tun(session: &Session, address: SocketAddr) {
    let deadline = Instant::now() + Duration::from_secs(9);
    let mut stream = loop {
        match TcpStream::connect_timeout(&address, Duration::from_millis(1500)) {
            Ok(stream) => break stream,
            Err(_) if Instant::now() < deadline && session.running() => {
                thread::sleep(Duration::from_millis(70));
            }
            Err(error) => panic!("The installed TUN's connection to {address} failed: {error}"),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    stream
        .write_all(b"GET /bridge HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut body = String::new();
    stream.read_to_string(&mut body).unwrap();
    assert!(body.ends_with("bridge"));
}

struct FixtureCore(Child);

impl Drop for FixtureCore {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn installed_mihomo_profile_captures_tcp_udp_and_dns_then_releases_the_tun() {
    let Some(app) = env::var_os("RELAYDESK_INSTALLED_SMOKE_APP").map(PathBuf::from) else {
        return;
    };
    let connect_proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    connect_proxy.set_nonblocking(true).unwrap();
    let http_port = port(&connect_proxy);
    let http = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        for destination in [TARGET, TARGET, TARGET, UPDATED_TARGET] {
            let mut socket = loop {
                match connect_proxy.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(30))
                    }
                    Err(error) => panic!("HTTP fixture was never reached: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            assert!(read_headers(&mut socket).starts_with(&format!("CONNECT {destination}:8089 ")));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            assert!(read_headers(&mut socket).starts_with("GET /bridge "));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 6\r\n\r\nbridge",
                )
                .unwrap();
        }
    });

    let echo = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    echo.set_read_timeout(Some(Duration::from_secs(45)))
        .unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    let udp = thread::spawn(move || {
        let mut buf = [0; 64];
        let (len, peer) = echo.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..len], b"relayed udp");
        echo.send_to(b"echo udp", peer).unwrap();
    });
    let ss_port = auxiliary_port(&[]).unwrap();
    let password = "bridge-fixture-only";
    let mut upstream = FixtureCore(
        core_command(&app.with_file_name("sing-box.exe"))
            .args(["run", "-c", "stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    upstream.0.stdin.take().unwrap().write_all(
        serde_json::to_vec(&json!({
            "inbounds":[{"type":"shadowsocks","tag":"relay","listen":"127.0.0.1","listen_port":ss_port,
                "method":"aes-128-gcm","password":password}],
            "outbounds":[{"type":"direct","tag":"direct"}],
            "route":{"rules":[{"inbound":"relay","outbound":"direct","override_address":"127.0.0.1","override_port":echo_port}]}
        })).unwrap().as_slice()
    ).unwrap();
    wait_until(
        || TcpStream::connect(("127.0.0.1", ss_port)).is_ok(),
        Duration::from_secs(4),
    );

    let resolver = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    resolver
        .set_read_timeout(Some(Duration::from_secs(45)))
        .unwrap();
    let resolver_port = resolver.local_addr().unwrap().port();
    let question = b"\x09relaydesk\x07fixture\x04test\x00\x00\x01\x00\x01";
    let dns = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut query = [0; 512];
        loop {
            let (len, peer) = resolver.recv_from(&mut query).unwrap();
            if query[..len].get(12..12 + question.len()) == Some(question.as_slice()) {
                let mut reply = query[..2].to_vec();
                reply.extend_from_slice(b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00");
                reply.extend_from_slice(question);
                reply.extend_from_slice(
                    b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x00\x00\x04\xc0\x00\x02\x0a",
                );
                resolver.send_to(&reply, peer).unwrap();
                break;
            }
            assert!(
                Instant::now() < deadline,
                "The intended synthetic query did not reach the original DNS"
            );
        }
    });

    let mixed = auxiliary_port(&[ss_port, http_port, resolver_port, echo_port]).unwrap();
    let mut settings = CoreSettings {
        core: Core::Mihomo,
        config: json!({
            "dns":{"enable":true,"ipv6":false,"nameserver":["system"],
                "nameserver-policy":{"relaydesk.fixture.test":[format!("udp://127.0.0.1:{resolver_port}")]}},
            "proxies":[
                {"name":"tcp-fixture","type":"http","server":"127.0.0.1","port":http_port},
                {"name":"udp-fixture","type":"ss","server":"127.0.0.1","port":ss_port,
                 "password":password,"cipher":"aes-128-gcm","udp":true}
            ],
            "proxy-groups":[{"name":"Fixture","type":"select","proxies":["tcp-fixture","REJECT"]}],
            "rules":[format!("DST-PORT,{echo_port},udp-fixture"), format!("IP-CIDR,{TARGET}/32,Fixture,no-resolve"), "MATCH,REJECT"]
        }),
        selections: BTreeMap::new(),
    };
    let mut session = Session::start_using(
        settings.clone(),
        mixed,
        "tun",
        RoutingMode::Rule,
        &app,
        true,
    )
    .unwrap();
    let (policy_dns, system_dns) = session.tun_dns.unwrap();
    assert!(session.running() && session.controller.ready());
    assert!(UdpSocket::bind((TUN_ADDRESS, 0)).is_ok());
    let target_address: std::net::Ipv4Addr = TARGET.parse().unwrap();
    let address = SocketAddr::from((target_address, 8089));
    let adapter = tun_interface(&session.id);
    let mut best = 0;
    let result = unsafe {
        winapi::um::iphlpapi::GetBestInterface(
            u32::from_ne_bytes(target_address.octets()),
            &mut best,
        )
    };
    assert_eq!(result, 0, "Windows could not resolve a route to {TARGET}");
    assert_eq!(
        Some(best),
        interface_index(&adapter),
        "Windows chose a different adapter for {TARGET}"
    );
    assert_http_through_tun(&session, address);

    let required = AF_INET as u16;
    assert!(tun_default_route(&adapter, required).is_some());
    for family in [required, AF_INET6 as u16] {
        if let Some(route) = tun_default_route(&adapter, family) {
            assert_eq!(
                unsafe { winapi::shared::netioapi::DeleteIpForwardEntry2(&route) }, 0,
                "Could not simulate loss of the test TUN's default route for address family {family}"
            );
            wait_until(
                || tun_default_route(&adapter, family).is_some(),
                Duration::from_secs(4),
            );
        }
    }
    assert!(session.running());
    assert_http_through_tun(&session, address);

    stop_fixture_core(&session, "sing-box.exe");
    wait_until(|| session.recovering_tun(), Duration::from_secs(3));
    assert!(session.running() && !session.ready());
    wait_until(|| session.ready(), Duration::from_secs(24));
    assert_eq!(session.generation(), 1);
    assert!(session.controller.ready());
    assert_http_through_tun(&session, address);

    let app_udp = UdpSocket::bind(("0.0.0.0", 0)).unwrap();
    app_udp
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    app_udp.connect((TARGET, echo_port)).unwrap();
    app_udp.send(b"relayed udp").unwrap();
    let mut data = [0; 512];
    let len = app_udp.recv(&mut data).unwrap();
    assert_eq!(&data[..len], b"echo udp");

    let app_dns = UdpSocket::bind(("0.0.0.0", 0)).unwrap();
    app_dns
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    app_dns.connect((TARGET, 53)).unwrap();
    let mut dns_query = b"\x19\x29\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00".to_vec();
    dns_query.extend_from_slice(question);
    app_dns.send(&dns_query).unwrap();
    let len = app_dns.recv(&mut data).unwrap();
    assert_eq!(&data[..2], b"\x19\x29");
    assert!(data[..len].ends_with(&[192, 0, 2, 10]));

    settings.config["proxy-groups"] = json!([{
        "name":"Updated","type":"select","proxies":["REJECT","tcp-fixture"]
    }]);
    settings.config["rules"] = json!([
        format!("IP-CIDR,{UPDATED_TARGET}/32,Updated,no-resolve"),
        "MATCH,REJECT"
    ]);
    settings
        .selections
        .insert("Updated".into(), "tcp-fixture".into());
    let updated = mihomo::prepare_tun_policy(
        &settings.config,
        mixed,
        RoutingMode::Rule,
        policy_dns,
        Some(system_dns),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert!(session.controller.reload_mihomo(updated).await.unwrap());
        session
            .controller
            .switch_group("Updated", "tcp-fixture")
            .await
            .unwrap();
    });
    stop_fixture_core(session.policy.as_ref().unwrap(), "mihomo.exe");
    wait_until(|| session.needs_policy_restart(), Duration::from_secs(3));
    assert!(session.running() && !session.ready());
    assert!(
        UdpSocket::bind((TUN_ADDRESS, 0)).is_ok(),
        "TUN stopped while the policy core was down"
    );
    session
        .stage_policy_restart(&settings, RoutingMode::Rule)
        .unwrap();
    assert!(!session.needs_policy_restart());
    wait_until(|| session.ready(), Duration::from_secs(24));
    assert_eq!(session.generation(), 2);
    runtime.block_on(async {
        let groups = session.controller.groups().await.unwrap();
        assert!(groups
            .iter()
            .any(|group| group.name == "Updated" && group.selected == "tcp-fixture"));
    });
    assert_http_through_tun(&session, format!("{UPDATED_TARGET}:8089").parse().unwrap());

    http.join().unwrap();
    udp.join().unwrap();
    dns.join().unwrap();

    session.policy.as_ref().unwrap().kill_fixture_worker();
    assert!(
        session.worker.signaled(5500),
        "TUN worker stayed up after losing its policy process"
    );
    session.stop().or_else(|_| recover()).unwrap();
    wait_until(
        || UdpSocket::bind((TUN_ADDRESS, 0)).is_err(),
        Duration::from_secs(4),
    );
    assert!(tun_default_route(&adapter, AF_INET as u16).is_none());
    assert!(tun_default_route(&adapter, AF_INET6 as u16).is_none());
    assert!(UdpSocket::bind(("127.0.0.1", policy_dns)).is_ok());
    assert!(UdpSocket::bind(("127.0.0.1", system_dns)).is_ok());
}

#[test]
fn installed_node_tun_keeps_the_selected_node_and_mode_and_can_cancel_recovery() {
    let Some(app) = env::var_os("RELAYDESK_INSTALLED_SMOKE_APP").map(PathBuf::from) else {
        return;
    };
    let port = auxiliary_port(&[]).unwrap();
    let mut config = json!({
        "inbounds":[{"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":port}],
        "outbounds":[
            {"type":"selector","tag":"proxy","outbounds":["node-0","node-1"],"default":"node-0","interrupt_exist_connections":false},
            {"type":"vless","tag":"node-0","server":"127.0.0.1","server_port":9,"uuid":"00000000-0000-4000-8000-000000000000"},
            {"type":"vless","tag":"node-1","server":"127.0.0.1","server_port":9,"uuid":"00000000-0000-4000-8000-000000000001"},
            {"type":"direct","tag":"direct"}
        ],
        "route":{"rules":[],"final":"proxy"}
    });
    let session = Session::start_using(
        CoreSettings::singbox(config.clone()),
        port,
        "tun",
        RoutingMode::Rule,
        &app,
        true,
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        session.controller.switch("node-1").await.unwrap();
        session.controller.routing_mode("direct").await.unwrap();
    });
    config["outbounds"][0]["default"] = json!("node-1");
    session.remember_tun_route(RoutingMode::Direct, &config);
    stop_fixture_core(&session, "sing-box.exe");
    wait_until(|| session.recovering_tun(), Duration::from_secs(3));
    wait_until(|| session.ready(), Duration::from_secs(24));
    assert_eq!(session.generation(), 1);
    assert!(
        session.controller.ready(),
        "The replacement node core did not answer a fresh controller request"
    );
    runtime.block_on(async {
        let groups = session.controller.groups().await.unwrap();
        assert!(groups
            .iter()
            .any(|group| group.name == "proxy" && group.selected == "node-1"));
        assert!(session
            .controller
            .current_routing_mode()
            .await
            .unwrap()
            .eq_ignore_ascii_case("direct"));
    });
    stop_fixture_core(&session, "sing-box.exe");
    wait_until(|| session.recovering_tun(), Duration::from_secs(3));
    session.configure_tun_recovery(false);
    assert!(
        session.worker.signaled(6500),
        "TUN recovered after recovery was disabled"
    );
    session.stop().or_else(|_| recover()).unwrap();
    wait_until(
        || UdpSocket::bind((TUN_ADDRESS, 0)).is_err(),
        Duration::from_secs(4),
    );
}
