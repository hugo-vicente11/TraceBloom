//! Container health probe: `tracebloom-collector healthcheck` connects to the
//! running collector's `/health` endpoint and exits 0/1. It exists so the slim
//! runtime image needs no curl/wget: the binary probes itself over plain
//! std TCP (no tokio runtime, no TLS: the target is always localhost).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Probe `GET /health` on the loopback interface at the port from `bind_addr`
/// (e.g. `0.0.0.0:4318`). Returns `true` only for an HTTP 200 status line.
pub fn probe_health(bind_addr: &str, timeout: Duration) -> bool {
    let Some(port) = parse_port(bind_addr) else {
        return false;
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    // Read until the status line is complete (first CRLF) or the peer closes.
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(2).any(|w| w == b"\r\n") || buf.len() >= 4096 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// The port component of a `host:port` bind address.
fn parse_port(bind_addr: &str) -> Option<u16> {
    bind_addr.rsplit(':').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    use super::{parse_port, probe_health};

    const TIMEOUT: Duration = Duration::from_secs(2);

    /// One-shot HTTP server on an ephemeral loopback port answering `response`.
    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn parses_ports() {
        assert_eq!(parse_port("0.0.0.0:4318"), Some(4318));
        assert_eq!(parse_port("127.0.0.1:80"), Some(80));
        assert_eq!(parse_port("nonsense"), None);
    }

    #[test]
    fn healthy_endpoint_probes_ok() {
        let port = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
        assert!(probe_health(&format!("0.0.0.0:{port}"), TIMEOUT));
    }

    #[test]
    fn error_status_fails_probe() {
        let port = serve_once("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
        assert!(!probe_health(&format!("0.0.0.0:{port}"), TIMEOUT));
    }

    #[test]
    fn refused_connection_fails_probe() {
        // Bind then drop to get a port that is very likely closed.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        assert!(!probe_health(&format!("0.0.0.0:{port}"), TIMEOUT));
    }
}
