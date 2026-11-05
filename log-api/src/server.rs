use std::time::Duration;

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch},
};
use tracing::info;

use crate::pob;
use crate::watcher::Status;
use crate::web_data;

/// The built guide (web/dist), compiled into the exe.
#[derive(RustEmbed)]
#[folder = "../web/dist/"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub lines: broadcast::Sender<String>,
    pub status: watch::Receiver<Status>,
    pub pob: pob::Engine,
}

pub async fn serve(listener: TcpListener, state: AppState) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route(WHOAMI_PATH, get(|| async { WHOAMI }))
        // PoB exports of big builds can pass axum's 2 MB default.
        .route(
            "/api/pob/stats",
            post(pob_stats).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/data/{name}", get(web_data))
        .fallback(static_handler)
        .with_state(state);

    axum::serve(listener, app).await?;
    Ok(())
}

/// Lets a second copy of the exe tell this one apart from another program on the port.
pub const WHOAMI_PATH: &str = "/api/whoami";
pub const WHOAMI: &str = "exile-leveling";

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    // Only this machine's pages may follow the log; other sites you visit can't.
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| client(socket, state))
}

fn local_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true; // not a browser page
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let authority = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or("");
    // The guide itself, however it was opened (e.g. a LAN address with --address 0.0.0.0:6754).
    let same_host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| !authority.is_empty() && h.eq_ignore_ascii_case(authority));
    if same_host {
        return true;
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

async fn client(mut socket: WebSocket, state: AppState) {
    let mut lines = state.lines.subscribe();
    let mut status = state.status.clone();
    let mut ping = tokio::time::interval(Duration::from_secs(5));

    let first = status.borrow_and_update().message();
    if socket.send(Message::Text(first.into())).await.is_err() {
        return;
    }
    info!("Guide connected");

    loop {
        tokio::select! {
            line = lines.recv() => match line {
                Ok(line) => {
                    if socket.send(Message::Text(line.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            changed = status.changed() => {
                if changed.is_err() { break; }
                let text = status.borrow_and_update().message();
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() { break; }
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    info!("Guide disconnected");
}

#[derive(Deserialize)]
struct StatsRequest {
    /// The build as PoB XML.
    xml: String,
    /// Loadout name from an earlier answer; none for the loadout the build was saved on.
    loadout: Option<String>,
    /// The guide's remembered main skill; none for PoB's own.
    pick: Option<pob::Pick>,
}

/// PoB's sidebar stats for a loadout of the imported build.
async fn pob_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StatsRequest>,
) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Long enough for PoB's first load plus a first-time timeless jewel download.
    let stats = state.pob.stats(request.xml, request.loadout, request.pick);
    match tokio::time::timeout(Duration::from_secs(180), stats).await {
        Ok(Ok(json)) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Ok(Err(msg)) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "PoB is taking too long. Restart the app.",
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct DataQuery {
    league: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// Trade site and poe.ninja data for the Gear panel (see web_data.rs), as JSON.
async fn web_data(
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<DataQuery>,
) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(source) =
        web_data::Source::parse(&name, query.league.as_deref(), query.kind.as_deref())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match web_data::fetch(source).await {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(file) => file_response(path, file),
        None if !path.contains('.') => match Assets::get("index.html") {
            Some(file) => file_response("index.html", file),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn file_response(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Hashed bundles never change; everything else is checked on each load.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        file.data,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn with_origin(origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        headers
    }

    #[test]
    fn only_local_origins_may_connect() {
        assert!(local_origin(&HeaderMap::new()));
        assert!(local_origin(&with_origin("http://127.0.0.1:6754")));
        assert!(local_origin(&with_origin("http://localhost:5173")));
        assert!(local_origin(&with_origin("http://[::1]:6754")));
        assert!(!local_origin(&with_origin("https://evil.example")));
        assert!(!local_origin(&with_origin("http://127.0.0.1.evil.example")));
        assert!(!local_origin(&with_origin("null")));

        let mut lan = with_origin("http://192.168.1.20:6754");
        lan.insert(header::HOST, HeaderValue::from_static("192.168.1.20:6754"));
        assert!(local_origin(&lan), "the guide opened from a LAN address");
        let mut rebind = with_origin("http://evil.example");
        rebind.insert(header::HOST, HeaderValue::from_static("127.0.0.1:6754"));
        assert!(!local_origin(&rebind));
    }
}
