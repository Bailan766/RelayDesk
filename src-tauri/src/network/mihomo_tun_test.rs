use super::*;
use std::io::{BufRead, BufReader, Read, Write};

const TARGET: &str = "198.18.117.33";
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
        assert!(read_headers(&mut socket).starts_with(&format!("CONNECT {TARGET}:8089 ")));
        socket
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .unwrap();
        assert!(read_headers(&mut socket).starts_with("GET /bridge "));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 6\r\n\r\nbridge")
            .unwrap();
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
    let session = Session::start_using(
        CoreSettings {
            core: Core::Mihomo,
            config: json!({
                "dns":{"enable":true,"ipv6":false,"nameserver":[format!("udp://127.0.0.1:{resolver_port}")]},
                "proxies":[
                    {"name":"tcp-fixture","type":"http","server":"127.0.0.1","port":http_port},
                    {"name":"udp-fixture","type":"ss","server":"127.0.0.1","port":ss_port,
                     "password":password,"cipher":"aes-128-gcm","udp":true}
                ],
                "proxy-groups":[{"name":"Fixture","type":"select","proxies":["tcp-fixture","REJECT"]}],
                "rules":[format!("DST-PORT,{echo_port},udp-fixture"), format!("IP-CIDR,{TARGET}/32,Fixture,no-resolve"), "MATCH,REJECT"]
            }),
            selections: BTreeMap::new(),
        },
        mixed, "tun", RoutingMode::Rule, &app,
    ).unwrap();
    let policy_dns = session.policy_dns.unwrap();
    assert!(session.running() && session.controller.ready());
    assert!(UdpSocket::bind((TUN_ADDRESS, 0)).is_ok());

    let mut stream = TcpStream::connect_timeout(
        &format!("{TARGET}:8089").parse().unwrap(),
        Duration::from_secs(4),
    )
    .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    stream
        .write_all(b"GET /bridge HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut body = String::new();
    stream.read_to_string(&mut body).unwrap();
    assert!(body.ends_with("bridge"));

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
    assert!(UdpSocket::bind(("127.0.0.1", policy_dns)).is_ok());
}
