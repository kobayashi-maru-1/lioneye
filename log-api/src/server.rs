use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

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
use serde::{Deserialize, Serialize};
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
    /// The in-game bar's settings, from the guide's Settings page (see overlay.rs).
    pub overlay: Arc<watch::Sender<OverlayConfig>>,
    pub guides: Arc<Guides>,
    /// Tooltips for the in-game bar's buttons, from the guide: panel id → JSON (the Gems
    /// panel's set, Campaign's next steps). Passed on to the bar as is.
    pub tips: Arc<watch::Sender<Tips>>,
    /// The guide's saved data, kept by the exe (saved-state.rs).
    pub saved: Arc<crate::saved_state::SavedState>,
}

pub type Tips = std::collections::BTreeMap<String, String>;

/// The largest tooltip the guide may send (a big build's gem set is a few KB).
const MAX_TIP: usize = 64 * 1024;
/// How many buttons may have a tooltip.
const MAX_TIPS: usize = 12;

/// "tips:{"gems":…,"campaign":…}": ids are checked panel ids and values checked JSON.
fn tips_message(tips: &Tips) -> String {
    let entries: Vec<String> = tips
        .iter()
        .map(|(id, json)| format!("\"{id}\":{json}"))
        .collect();
    format!("tips:{{{}}}", entries.join(","))
}

/// Tells pages which guide this exe serves, so a page left open across an exe update
/// reloads itself (the guide compares it with the first one it saw).
fn build_message() -> &'static str {
    static BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        if let Some(index) = Assets::get("index.html") {
            index.data.hash(&mut hasher);
        }
        format!("build:{:016x}", hasher.finish())
    })
}

/// A button on the in-game bar: the guide panel it jumps to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayButton {
    pub id: String,
    pub label: String,
}

/// Whether the in-game bar shows, and its buttons in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayConfig {
    pub on: bool,
    pub buttons: Vec<OverlayButton>,
}

impl Default for OverlayConfig {
    /// As the guide's Settings default, until the guide first sends its own.
    fn default() -> Self {
        let button = |id: &str, label: &str| OverlayButton {
            id: id.into(),
            label: label.into(),
        };
        Self {
            on: true,
            buttons: vec![
                button("campaign", "Campaign"),
                button("gear", "Gear"),
                button("gems", "Gems"),
                button("tree", "Tree"),
                button("notes", "Notes"),
            ],
        }
    }
}

/// What the guide sends: buttons are left out when the page doesn't know which panels the
/// build has (Settings opened before the guide), and the last ones are kept.
#[derive(Deserialize)]
struct OverlayUpdate {
    on: bool,
    buttons: Option<Vec<OverlayButton>>,
}

/// The open guide pages, so a bar button can open one when there's none.
pub struct Guides {
    /// Under one lock, so a guide connecting while a button is clicked can't miss the jump.
    state: Mutex<GuideState>,
    /// Asks the tray thread to open the guide.
    request_open: std::sync::mpsc::Sender<()>,
}

#[derive(Default)]
struct GuideState {
    /// Guide pages connected.
    open: usize,
    /// A jump asked for while no guide was open, for the next one that connects.
    pending: Option<(String, Instant)>,
}

/// How long a jump waits for a guide page to open and connect.
const PENDING_JUMP: Duration = Duration::from_secs(15);

impl Guides {
    pub fn new(request_open: std::sync::mpsc::Sender<()>) -> Self {
        Self {
            state: Mutex::new(GuideState::default()),
            request_open,
        }
    }

    fn lock(&self) -> MutexGuard<'_, GuideState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A guide page connected: the jump waiting for it, if any.
    fn connected(&self) -> Option<String> {
        let mut state = self.lock();
        state.open += 1;
        state
            .pending
            .take()
            .filter(|(_, at)| at.elapsed() < PENDING_JUMP)
            .map(|(id, _)| id)
    }

    fn disconnected(&self) {
        let mut state = self.lock();
        state.open = state.open.saturating_sub(1);
    }

    /// True when a guide is open; otherwise keeps the jump for the next one to connect.
    fn open_or_wait(&self, id: &str) -> bool {
        let mut state = self.lock();
        if state.open > 0 {
            state.pending = None;
            true
        } else {
            state.pending = Some((id.to_string(), Instant::now()));
            false
        }
    }
}

/// A panel id from the page: short lowercase words only.
fn panel_id(id: &str) -> Option<&str> {
    (!id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
        .then_some(id)
}

/// A bar button: tells the open guide pages to jump and brings one up, or opens one.
async fn jump(state: &AppState, id: &str) {
    if state.guides.open_or_wait(id) {
        let _ = state.lines.send(format!("jump:{id}"));
        #[cfg(windows)]
        let _ = tokio::task::spawn_blocking(crate::guide_window::raise).await;
    } else {
        let _ = state.guides.request_open.send(());
    }
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

fn overlay_message(config: &OverlayConfig) -> String {
    format!(
        "overlay:{}",
        serde_json::to_string(config).unwrap_or_default()
    )
}

/// One page on the socket: the guide (it says "guide" first) or the in-game bar.
async fn client(socket: WebSocket, state: AppState) {
    let mut guide = false;
    serve_client(socket, &state, &mut guide).await;
    if guide {
        state.guides.disconnected();
    }
    info!("Page disconnected");
}

async fn serve_client(mut socket: WebSocket, state: &AppState, guide: &mut bool) {
    let mut lines = state.lines.subscribe();
    let mut status = state.status.clone();
    let mut overlay = state.overlay.subscribe();
    let mut tips = state.tips.subscribe();
    let mut ping = tokio::time::interval(Duration::from_secs(5));

    if socket
        .send(Message::Text(build_message().into()))
        .await
        .is_err()
    {
        return;
    }
    let first = status.borrow_and_update().message();
    if socket.send(Message::Text(first.into())).await.is_err() {
        return;
    }
    let config = overlay_message(&overlay.borrow_and_update());
    if socket.send(Message::Text(config.into())).await.is_err() {
        return;
    }
    let all = tips_message(&tips.borrow_and_update());
    if socket.send(Message::Text(all.into())).await.is_err() {
        return;
    }
    if socket
        .send(Message::Text(state.saved.message().into()))
        .await
        .is_err()
    {
        return;
    }
    info!("Page connected");

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
            changed = overlay.changed() => {
                if changed.is_err() { break; }
                let text = overlay_message(&overlay.borrow_and_update());
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            },
            changed = tips.changed() => {
                if changed.is_err() { break; }
                let text = tips_message(&tips.borrow_and_update());
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() { break; }
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Text(text))) => {
                    let text = text.as_str();
                    if text == "guide" && !*guide {
                        *guide = true;
                        // A bar button opened this guide: do the jump it asked for.
                        if let Some(id) = state.guides.connected() {
                            let text = format!("jump:{id}");
                            if socket.send(Message::Text(text.into())).await.is_err() { break; }
                        }
                    } else if let Some(json) = text.strip_prefix("overlay:") {
                        if let Ok(update) = serde_json::from_str::<OverlayUpdate>(json) {
                            state.overlay.send_if_modified(|config| {
                                let mut next = config.clone();
                                next.on = update.on;
                                if let Some(buttons) = update.buttons {
                                    next.buttons = buttons
                                        .into_iter()
                                        .filter(|b| panel_id(&b.id).is_some() && b.label.len() <= 24)
                                        .take(12)
                                        .collect();
                                }
                                let changed = next != *config;
                                *config = next;
                                changed
                            });
                        }
                    } else if let Some(id) = text.strip_prefix("jump:").and_then(panel_id) {
                        jump(state, id).await;
                    } else if let Some(rest) = text.strip_prefix("tip:") {
                        // "tip:<panel>:<json>": a button's tooltip, passed on to the bar as
                        // is (checked to be JSON, kept small).
                        if let Some((id, json)) = rest.split_once(':')
                            && panel_id(id).is_some()
                            && json.len() <= MAX_TIP
                            && serde_json::from_str::<serde_json::Value>(json).is_ok()
                        {
                            state.tips.send_if_modified(|tips| {
                                if tips.get(id).is_some_and(|old| old == json)
                                    || (!tips.contains_key(id) && tips.len() >= MAX_TIPS)
                                {
                                    return false;
                                }
                                tips.insert(id.to_string(), json.to_string());
                                true
                            });
                        }
                    } else if let Some(json) = text.strip_prefix("state:") {
                        // The guide's own window: its data changed. Written off the runtime.
                        let saved = state.saved.clone();
                        let json = json.to_string();
                        let _ = tokio::task::spawn_blocking(move || saved.save(&json)).await;
                    } else if let Some(json) = text.strip_prefix("state-offer:") {
                        // A window opened in an old Edge profile, for the one-time move.
                        state.saved.offer(json);
                    }
                }
                Some(Ok(_)) => {}
            },
        }
    }
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
