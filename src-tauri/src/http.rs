use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, LOCATION};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tokio_util::sync::CancellationToken;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 8;
const CANCELLED: &str = "Request cancelled";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    request_id: String,
    url: String,
    #[serde(default = "get_method")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<Value>,
    #[serde(default)]
    public_only: bool,
}

fn get_method() -> String {
    "GET".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    body: String,
}

#[derive(Default)]
struct RequestRegistry {
    active: HashMap<String, CancellationToken>,
    // Handles cancellation racing ahead of the request's IPC dispatch.
    cancelled: HashMap<String, Instant>,
}

pub struct HttpState {
    client: Client,
    registry: Arc<Mutex<RequestRegistry>>,
}

struct RequestGuard {
    id: String,
    registry: Arc<Mutex<RequestRegistry>>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.active.remove(&self.id);
        }
    }
}

fn validate_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 4096 {
        return Err("The endpoint URL is too long".into());
    }
    let url = Url::parse(raw).map_err(|_| "Use a valid HTTP or HTTPS endpoint URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Keep credentials in the API key field rather than in the URL".into());
    }
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Use HTTPS for remote endpoints or HTTP for a localhost model server".into());
    }
    Ok(url)
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The request identifier is invalid".into());
    }
    Ok(())
}

fn is_public_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_broadcast()
                && !address.is_documentation()
                && a != 0
                && a < 240
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && b == 0 && c == 0)
        }
        std::net::IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_address(std::net::IpAddr::V4(mapped));
            }
            let segments = address.segments();
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && segments[0] & 0xfe00 != 0xfc00
                && segments[0] & 0xffc0 != 0xfe80
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && segments[0] & 0xe000 == 0x2000
        }
    }
}

async fn public_client(url: &Url) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or("The website has no host")?
        .trim_matches(['[', ']']);
    let port = url
        .port_or_known_default()
        .ok_or("The website port is not supported")?;
    let addresses: Vec<std::net::SocketAddr> = if let Ok(address) = host.parse() {
        vec![std::net::SocketAddr::new(address, port)]
    } else {
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "Website DNS resolution timed out")?
        .map_err(|_| "Could not resolve this website")?
        .collect()
    };
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !is_public_address(address.ip()))
    {
        return Err("Website imports cannot access private or local network addresses".into());
    }
    // Pin the checked resolution to this request, avoiding a second lookup
    // that could resolve to a local address. A redirect gets a fresh check.
    Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("TypeNext/0.1")
        .build()
        .map_err(http_error)
}

fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The server took too long to respond. Try again or check the model server.".into()
    } else if error.is_connect() {
        "Could not connect to the server. Check the endpoint and that your model server is running."
            .into()
    } else {
        // Never expose URLs, headers or API keys through a debug-formatted error.
        "The server request failed before a complete response was received".into()
    }
}

impl HttpState {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("TypeNext/0.1")
                .build()?,
            registry: Arc::new(Mutex::new(RequestRegistry::default())),
        })
    }

    fn begin(&self, id: &str) -> Result<(CancellationToken, RequestGuard), String> {
        validate_request_id(id)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "The request registry is unavailable")?;
        registry
            .cancelled
            .retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if registry.cancelled.remove(id).is_some() {
            return Err(CANCELLED.into());
        }
        if registry.active.contains_key(id) {
            return Err("This request identifier is already in use".into());
        }
        if registry.active.len() >= MAX_CONCURRENT_REQUESTS {
            return Err("Too many requests are already running. Try again shortly.".into());
        }
        let token = CancellationToken::new();
        registry.active.insert(id.into(), token.clone());
        Ok((
            token,
            RequestGuard {
                id: id.into(),
                registry: self.registry.clone(),
            },
        ))
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        validate_request_id(id)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "The request registry is unavailable")?;
        if let Some(token) = registry.active.get(id) {
            token.cancel();
        } else {
            registry
                .cancelled
                .retain(|_, at| at.elapsed() < Duration::from_secs(60));
            if registry.cancelled.len() >= 256 {
                if let Some(oldest) = registry
                    .cancelled
                    .iter()
                    .min_by_key(|(_, at)| *at)
                    .map(|(id, _)| id.clone())
                {
                    registry.cancelled.remove(&oldest);
                }
            }
            registry.cancelled.insert(id.into(), Instant::now());
        }
        Ok(())
    }

    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let (token, _guard) = self.begin(&request.request_id)?;
        // Dropping send/read futures closes the unfinished HTTP request when
        // cancelled, rather than merely ignoring a stale response in JavaScript.
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(CANCELLED.into()),
            response = tokio::time::timeout(Duration::from_secs(60), self.send(request)) =>
                response.map_err(|_| "The server took too long to respond. Try again or check the model server.".to_string())?,
        }
    }

    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let mut url = validate_url(&request.url)?;
        let method = match request.method.to_ascii_uppercase().as_str() {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "HEAD" => Method::HEAD,
            _ => return Err("Only GET, HEAD and POST requests are supported".into()),
        };
        if request.headers.len() > 64 {
            return Err("Too many request headers".into());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in request.headers {
            if value.len() > 8192 {
                return Err("A request header is too long".into());
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "A request header name is invalid")?;
            if matches!(
                name.as_str(),
                "host" | "content-length" | "connection" | "proxy-authorization" | "cookie"
            ) {
                return Err("This request header is not supported".into());
            }
            let value =
                HeaderValue::from_str(&value).map_err(|_| "A request header value is invalid")?;
            headers.insert(name, value);
        }
        let body = request
            .body
            .map(|body| serde_json::to_vec(&body))
            .transpose()
            .map_err(|_| "The request body could not be serialized")?;
        if body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
        {
            return Err("The request body exceeds the supported size (2 MB)".into());
        }
        if body.is_some() && method != Method::POST {
            return Err("Only POST requests may contain a body".into());
        }
        if body.is_some() && !headers.contains_key(CONTENT_TYPE) {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let started = Instant::now();
        let mut redirects = 0;
        let mut response = loop {
            let remaining = Duration::from_secs(60)
                .checked_sub(started.elapsed())
                .ok_or("The server took too long to respond")?;
            let guarded_client;
            let client = if request.public_only {
                guarded_client = public_client(&url).await?;
                &guarded_client
            } else {
                &self.client
            };
            let mut outgoing = client
                .request(method.clone(), url.clone())
                .headers(headers.clone())
                .timeout(remaining);
            if let Some(body) = &body {
                outgoing = outgoing.body(body.clone());
            }
            let response = outgoing.send().await.map_err(http_error)?;
            // Redirect website GETs, but never replay a provider POST or its
            // credentials to a different endpoint. Strip all custom headers
            // when a website redirects between origins.
            if response.status().is_redirection()
                && (method == Method::GET || method == Method::HEAD)
            {
                let Some(location) = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                else {
                    break response;
                };
                redirects += 1;
                if redirects > 5 {
                    return Err("This website redirects too many times".into());
                }
                let next = url
                    .join(location)
                    .map_err(|_| "The website returned an invalid redirect")?;
                let next = validate_url(next.as_str())?;
                if next.origin() != url.origin() {
                    headers.clear();
                }
                url = next;
                continue;
            }
            break response;
        };
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("The server response exceeds the supported size (8 MB)".into());
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("The server response exceeds the supported size (8 MB)".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes).map_err(|_| "The server did not return UTF-8 text")?;
        Ok(HttpResponse { status, body })
    }
}

#[tauri::command]
pub async fn http_request(
    state: State<'_, HttpState>,
    request: HttpRequest,
) -> Result<HttpResponse, String> {
    state.execute(request).await
}

#[tauri::command]
pub fn cancel_http_request(state: State<'_, HttpState>, request_id: String) -> Result<(), String> {
    state.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn request(url: String) -> HttpRequest {
        HttpRequest {
            request_id: "test-request".into(),
            url,
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            public_only: false,
        }
    }

    fn server(response: &'static str, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes);
            std::thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{address}")
    }

    #[test]
    fn urls_reject_remote_plaintext_and_embedded_credentials() {
        assert!(validate_url("https://api.openai.com/v1").is_ok());
        assert!(validate_url("http://localhost:1234/v1").is_ok());
        assert!(validate_url("http://[::1]:8000/v1").is_ok());
        assert!(validate_url("http://127.0.0.2:8000/v1").is_ok());
        assert!(validate_url("http://example.com/v1").is_err());
        assert!(validate_url("https://user:secret@example.com").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn website_address_guard_covers_private_ranges_and_ipv4_mapped_ipv6() {
        for address in [
            "127.0.0.1",
            "192.168.1.2",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_address(address.parse().unwrap()),
                "{address} must be blocked"
            );
        }
        assert!(is_public_address("1.1.1.1".parse().unwrap()));
        assert!(is_public_address("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn cancellation_before_ipc_dispatch_is_not_lost() {
        let state = HttpState::new().unwrap();
        state.cancel("pending-request").unwrap();
        assert_eq!(state.begin("pending-request").err().unwrap(), CANCELLED);
        assert!(state.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn cancel_interrupts_a_real_request_and_cleans_the_registry() {
        let state = HttpState::new().unwrap();
        let url = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nlate",
            Duration::from_secs(1),
        );
        let (result, _) = tokio::join!(state.execute(request(url)), async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            state.cancel("test-request").unwrap();
        });
        assert_eq!(result.err().unwrap(), CANCELLED);
        assert!(state.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn oversized_responses_are_rejected_before_buffering_the_body() {
        let state = HttpState::new().unwrap();
        let url = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n",
            Duration::ZERO,
        );
        assert!(state
            .execute(request(url))
            .await
            .err()
            .unwrap()
            .contains("8 MB"));
        assert!(state.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn provider_status_and_body_are_preserved_for_frontend_errors() {
        let state = HttpState::new().unwrap();
        let url = server("HTTP/1.1 401 Unauthorized\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"error\":\"no key\"}", Duration::ZERO);
        let response = state.execute(request(url)).await.unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(response.body, "{\"error\":\"no key\"}");
    }
}
