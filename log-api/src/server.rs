use std::time::Duration;

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch},
};
use tracing::info;

use crate::watcher::Status;

/// The built guide (web/dist), compiled into the exe.
#[derive(RustEmbed)]
#[folder = "../web/dist/"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub lines: broadcast::Sender<String>,
    pub status: watch::Receiver<Status>,
}

pub async fn serve(listener: TcpListener, state: AppState) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback(static_handler)
        .with_state(state);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| client(socket, state))
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
